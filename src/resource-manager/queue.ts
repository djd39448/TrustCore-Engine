/**
 * LLM inference request priority queue.
 *
 * Priority levels (lower = higher priority):
 *   1 — alex_routing    (Alex routing and orchestration decisions)
 *   2 — agent_execution (sub-agent task execution)
 *   3 — embeddings      (embedding generation)
 *   4 — factory         (training factory requests)
 *
 * Behaviour:
 *   - Requests queue when maxConcurrent slots are full
 *   - Processed in priority order (min-heap)
 *   - Max queue depth: 50 — rejects with error beyond that
 *   - Request timeout: 360 seconds — allows large models (9b+) to load from disk
 *   - Logs queue depth to unified_memory when depth >= 3
 *   - Emits events: queued, started, completed, failed, timeout
 */

import { EventEmitter } from 'events';
import { query } from '../db/client.js';

export type Priority = 1 | 2 | 3 | 4;

export interface QueueRequest<T = unknown> {
  id: string;
  priority: Priority;
  label: string;
  modelName: string;
  modelSizeGB: number;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

const MAX_QUEUE_SIZE = 50;
const MAX_CONCURRENT = 2;
const LOG_DEPTH_THRESHOLD = 3;
const REQUEST_TIMEOUT_MS = 360_000;

let active = 0;
let requestCounter = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const heap: QueueRequest<any>[] = [];

export const queueEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// Min-heap helpers
// ---------------------------------------------------------------------------

function heapUp(i: number): void {
  while (i > 0) {
    const parent = Math.floor((i - 1) / 2);
    if (heap[parent]!.priority <= heap[i]!.priority) break;
    [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
    i = parent;
  }
}

function heapDown(i: number): void {
  const n = heap.length;
  while (true) {
    let min = i;
    const l = 2 * i + 1;
    const r = 2 * i + 2;
    if (l < n && heap[l]!.priority < heap[min]!.priority) min = l;
    if (r < n && heap[r]!.priority < heap[min]!.priority) min = r;
    if (min === i) break;
    [heap[min], heap[i]] = [heap[i]!, heap[min]!];
    i = min;
  }
}

function pop(): QueueRequest | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    heapDown(0);
  }
  return top;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

async function logQueueDepth(depth: number): Promise<void> {
  try {
    const sys = await query<{ id: string }>(`SELECT id FROM agents WHERE slug = 'system' LIMIT 1`);
    const authorId = sys.rows[0]?.id;
    if (!authorId) return;
    await query(
      `INSERT INTO unified_memory (author_agent_id, event_type, summary, content, importance)
       VALUES ($1, 'observation', $2, $3, 2)`,
      [
        authorId,
        `LLM queue depth at ${depth} — requests queuing behind active inference`,
        JSON.stringify({ queue_depth: depth, active_requests: active }),
      ]
    );
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

function drain(): void {
  while (active < MAX_CONCURRENT && heap.length > 0) {
    const req = pop();
    if (!req) break;

    // Cancel timeout that was set while queued; will be reset for execution
    if (req.timeoutHandle) clearTimeout(req.timeoutHandle);

    active++;
    queueEvents.emit('started', { id: req.id, label: req.label, priority: req.priority });

    // Set execution timeout
    const execTimeout = setTimeout(() => {
      active--;
      console.error(`[Queue] Request "${req.label}" (${req.id}) timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      queueEvents.emit('timeout', { id: req.id, label: req.label });
      req.reject(new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${req.label}`));
      drain();
    }, REQUEST_TIMEOUT_MS);

    req.fn()
      .then((result) => {
        clearTimeout(execTimeout);
        queueEvents.emit('completed', { id: req.id, label: req.label });
        req.resolve(result);
      })
      .catch((err: unknown) => {
        clearTimeout(execTimeout);
        queueEvents.emit('failed', { id: req.id, label: req.label, error: err });
        req.reject(err);
      })
      .finally(() => {
        active--;
        drain();
      });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue an LLM inference request.
 * Returns a promise that resolves/rejects when the request completes.
 */
export function enqueue<T>(
  priority: Priority,
  label: string,
  modelName: string,
  modelSizeGB: number,
  fn: () => Promise<T>
): Promise<T> {
  const id = `req_${++requestCounter}`;

  // Fast path — slot available
  if (active < MAX_CONCURRENT) {
    active++;
    queueEvents.emit('started', { id, label, priority });

    return new Promise<T>((resolve, reject) => {
      const execTimeout = setTimeout(() => {
        active--;
        console.error(`[Queue] Request "${label}" (${id}) timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
        queueEvents.emit('timeout', { id, label });
        reject(new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${label}`));
        drain();
      }, REQUEST_TIMEOUT_MS);

      fn()
        .then((result) => { clearTimeout(execTimeout); queueEvents.emit('completed', { id, label }); resolve(result); })
        .catch((err: unknown) => { clearTimeout(execTimeout); queueEvents.emit('failed', { id, label, error: err }); reject(err); })
        .finally(() => { active--; drain(); });
    });
  }

  // Queue full
  if (heap.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(
      new Error(`LLM queue full (${MAX_QUEUE_SIZE} pending). Request "${label}" rejected. Retry later.`)
    );
  }

  queueEvents.emit('queued', { id, label, priority, queueDepth: heap.length + 1 });

  const depth = heap.length + 1;
  if (depth >= LOG_DEPTH_THRESHOLD) {
    void logQueueDepth(depth);
  }

  return new Promise<T>((resolve, reject) => {
    const req: QueueRequest<T> = {
      id, priority, label, modelName, modelSizeGB, fn,
      resolve, reject,
      enqueuedAt: Date.now(),
    };

    // Enqueue timeout — if still waiting after timeout, reject
    req.timeoutHandle = setTimeout(() => {
      // Remove from heap
      const idx = heap.indexOf(req);
      if (idx !== -1) {
        heap.splice(idx, 1);
        // Rebuild heap property (simple re-heapify)
        for (let i = Math.floor(heap.length / 2) - 1; i >= 0; i--) heapDown(i);
      }
      console.error(`[Queue] Queued request "${label}" (${id}) timed out waiting (${REQUEST_TIMEOUT_MS / 1000}s)`);
      queueEvents.emit('timeout', { id, label });
      reject(new Error(`LLM request timed out waiting in queue after ${REQUEST_TIMEOUT_MS / 1000}s: ${label}`));
    }, REQUEST_TIMEOUT_MS);

    heap.push(req);
    heapUp(heap.length - 1);
  });
}

/** Returns current queue state for the /api/queue endpoint. */
export function getQueueStatus(): {
  depth: number;
  active: number;
  maxConcurrent: number;
  pending: { id: string; label: string; priority: number; modelName: string; waitMs: number }[];
} {
  const now = Date.now();
  return {
    depth: heap.length,
    active,
    maxConcurrent: MAX_CONCURRENT,
    pending: heap.map((r) => ({
      id: r.id,
      label: r.label,
      priority: r.priority,
      modelName: r.modelName,
      waitMs: now - r.enqueuedAt,
    })),
  };
}
