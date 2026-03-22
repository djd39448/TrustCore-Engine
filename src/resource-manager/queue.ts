/**
 * LLM inference request queue.
 *
 * Priority levels (lower number = higher priority):
 *   1 — alex routing decisions
 *   2 — sub-agent task execution
 *   3 — embedding generation
 *   4 — training factory requests
 *
 * Requests queue when concurrency is saturated (maxConcurrent).
 * Processed in priority order. Max queue depth 50; rejects beyond that.
 * Logs queue depth to unified_memory when depth exceeds 3.
 */

import { query } from '../db/client.js';

export type Priority = 1 | 2 | 3 | 4;

export interface QueueRequest<T> {
  priority: Priority;
  label: string;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

const MAX_QUEUE_SIZE = 50;
const MAX_CONCURRENT = 2; // allow up to 2 simultaneous LLM calls
const LOG_DEPTH_THRESHOLD = 3;

let active = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const heap: QueueRequest<any>[] = [];

// Min-heap helpers (lower priority value = higher priority)
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

function pop(): QueueRequest<unknown> | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    heapDown(0);
  }
  return top;
}

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
        `LLM queue depth reached ${depth} — requests are queuing behind active inference`,
        JSON.stringify({ queue_depth: depth, active_requests: active }),
      ]
    );
  } catch {
    // non-fatal
  }
}

async function drain(): Promise<void> {
  while (active < MAX_CONCURRENT && heap.length > 0) {
    const req = pop();
    if (!req) break;
    active++;

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    req
      .fn()
      .then(req.resolve)
      .catch(req.reject)
      .finally(() => {
        active--;
        void drain();
      });
  }
}

/**
 * Enqueue an LLM request. Returns a promise that resolves when the request completes.
 * Throws immediately if the queue is full.
 */
export function enqueue<T>(priority: Priority, label: string, fn: () => Promise<T>): Promise<T> {
  if (active < MAX_CONCURRENT) {
    // Fast path — slot available, run immediately
    active++;
    return fn().finally(() => {
      active--;
      void drain();
    });
  }

  if (heap.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(
      new Error(
        `LLM queue full (${MAX_QUEUE_SIZE} pending). Request "${label}" rejected. Try again later.`
      )
    );
  }

  return new Promise<T>((resolve, reject) => {
    heap.push({ priority, label, fn, resolve, reject, enqueuedAt: Date.now() });
    heapUp(heap.length - 1);

    const depth = heap.length;
    if (depth >= LOG_DEPTH_THRESHOLD) {
      void logQueueDepth(depth);
    }
  });
}

/**
 * Returns current queue state for the API endpoint.
 */
export function getQueueStatus(): { depth: number; active: number; pending: { label: string; priority: number; waitMs: number }[] } {
  const now = Date.now();
  return {
    depth: heap.length,
    active,
    pending: heap.map((r) => ({
      label: r.label,
      priority: r.priority,
      waitMs: now - r.enqueuedAt,
    })),
  };
}
