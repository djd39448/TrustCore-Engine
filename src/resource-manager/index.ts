/**
 * Resource Manager — GPU metrics collection and VRAM-aware LLM scheduling.
 *
 * GPU 1 — Alex's permanent home. qwen2.5:14b always loaded (KEEP_ALIVE=-1),
 *          never evicted. OLLAMA_NUM_CTX=4096 keeps it at 10 GB. Never used
 *          for sub-agent work.
 * GPU 0 — Shared execution pool. Dynamic VRAM-aware scheduling.
 *          Sub-agents (qwen2.5:7b, qwen3.5:9b) and factory load/run in
 *          parallel up to VRAM limit. KEEP_ALIVE=0 evicts after each request.
 *
 * This service:
 *   1. Polls nvidia-smi every 5 seconds for VRAM/util/temp on both GPUs
 *   2. Tracks currentGpu0VramUsedMB live for scheduling decisions
 *   3. Stores metrics in gpu_metrics table
 *   4. Exposes getAvailableSlots(modelName), canDispatchNow(modelName), recommendHost(modelName)
 *   5. Maintains a priority queue for GPU 0 when slots are full
 *   6. Writes system_alert to unified_memory when GPU util > 80%
 *   7. Writes observation summary to unified_memory every 30 minutes
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { query } from '../db/client.js';

const execAsync = promisify(exec);

const POLL_INTERVAL_MS = 5_000;
const SUMMARY_INTERVAL_MS = 30 * 60_000;
const HIGH_UTIL_THRESHOLD = 80; // percent

// ---------------------------------------------------------------------------
// Model VRAM reference table (GB)
// ---------------------------------------------------------------------------

/**
 * Approximate VRAM footprint in GB per model, at OLLAMA_NUM_CTX=4096.
 * Used by getAvailableSlots() and acquireSlot() to gate dispatch decisions.
 * Add new models here when onboarding them to the fleet.
 *
 * Note: actual VRAM depends on context length. These figures assume
 * num_ctx=4096 (the system-wide default set in src/llm/client.ts).
 * Larger contexts will use more VRAM and can exceed these estimates.
 */
const MODEL_VRAM_GB: Record<string, number> = {
  // GPU 1 only — Alex's permanent models, never schedule on GPU 0
  'qwen2.5:14b': 10,           // Alex's primary model (KEEP_ALIVE=-1 on GPU 1)
  'qwen3.5:35b-a3b': 20,       // legacy large model, GPU 1 only
  'qwen2.5-coder:32b': 19,     // code model, GPU 1 only

  // GPU 0 fleet — sub-agents and factory
  'qwen2.5:7b': 5,             // eval agent primary model (trustcore-eval container)
  'qwen3.5:27b': 16,
  'qwen3.5:9b': 6,
  'qwen3.5:4b': 3,
  'qwen3.5:2b': 2,
  'qwen2.5:0.5b': 1,
  'nomic-embed-text': 1,       // embedding model, always on GPU 0

  'default': 6,                // conservative fallback for unknown models
};

const GPU0_TOTAL_VRAM_MB = 24576;
const GPU0_HEADROOM_MB = 2048;                           // always reserve 2GB
const GPU0_AVAILABLE_MB = GPU0_TOTAL_VRAM_MB - GPU0_HEADROOM_MB; // 22GB usable

/**
 * Models that live exclusively on GPU 1 and must never be dispatched to GPU 0.
 * Includes Alex's primary model and any large model that only fits on GPU 1.
 * Note: qwen2.5:14b is NOT in this list because it's already on GPU 1 with
 * KEEP_ALIVE=-1 — it won't be loaded onto GPU 0 in practice, but the
 * resource manager doesn't need to enforce that separately.
 */
const GPU1_RESERVED_MODELS = ['qwen3.5:35b-a3b', 'qwen2.5-coder:32b'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GPUStatus {
  index: number;
  name: string;
  memoryUsedMb: number;
  memoryFreeMb: number;
  memoryTotalMb: number;
  utilizationPct: number;
  temperatureC: number | null;
}

/** Priority levels for GPU 0 queue */
export const PRIORITY = {
  ALEX_ROUTING: 1,
  SUB_AGENT: 2,
  EMBEDDING: 3,
  FACTORY: 4,
} as const;

interface QueuedRequest {
  priority: number;
  modelName: string;
  resolve: () => void;
  enqueuedAt: number;
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

let latestStats: GPUStatus[] = [];
let currentGpu0VramUsedMB = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let summaryTimer: ReturnType<typeof setInterval> | null = null;
const alerted = new Set<number>();
const pendingQueue: QueuedRequest[] = [];

// ---------------------------------------------------------------------------
// nvidia-smi parsing
// ---------------------------------------------------------------------------

async function querySmi(): Promise<GPUStatus[]> {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=index,name,memory.used,memory.free,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits'
    );

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(',').map((s) => s.trim());
        const [idx, name, used, free, total, util, temp] = parts;
        return {
          index: parseInt(idx ?? '0', 10),
          name: name ?? 'unknown',
          memoryUsedMb: parseInt(used ?? '0', 10),
          memoryFreeMb: parseInt(free ?? '0', 10),
          memoryTotalMb: parseInt(total ?? '0', 10),
          utilizationPct: parseInt(util ?? '0', 10),
          temperatureC: temp && temp !== '[N/A]' ? parseInt(temp, 10) : null,
        };
      });
  } catch {
    console.warn('[ResourceManager] nvidia-smi unavailable — returning mock GPU data');
    return [
      { index: 0, name: 'Mock GPU (nvidia-smi unavailable)', memoryUsedMb: 0, memoryFreeMb: 24576, memoryTotalMb: 24576, utilizationPct: 0, temperatureC: null },
      { index: 1, name: 'Mock GPU (nvidia-smi unavailable)', memoryUsedMb: 0, memoryFreeMb: 24576, memoryTotalMb: 24576, utilizationPct: 0, temperatureC: null },
    ];
  }
}

// ---------------------------------------------------------------------------
// DB writes
// ---------------------------------------------------------------------------

async function persistStats(stats: GPUStatus[]): Promise<void> {
  for (const g of stats) {
    await query(
      `INSERT INTO gpu_metrics
         (gpu_index, gpu_name, memory_used_mb, memory_free_mb, memory_total_mb, utilization_percent, temperature_c)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [g.index, g.name, g.memoryUsedMb, g.memoryFreeMb, g.memoryTotalMb, g.utilizationPct, g.temperatureC ?? null]
    );
  }
}

async function getSystemAgentId(): Promise<string | null> {
  const r = await query<{ id: string }>(`SELECT id FROM agents WHERE slug = 'system' LIMIT 1`);
  return r.rows[0]?.id ?? null;
}

async function writeMemoryEvent(
  eventType: 'system_alert' | 'observation',
  summary: string,
  content: unknown,
  importance: number
): Promise<void> {
  try {
    const authorId = await getSystemAgentId();
    if (!authorId) return;
    await query(
      `INSERT INTO unified_memory (author_agent_id, event_type, summary, content, importance)
       VALUES ($1, $2, $3, $4, $5)`,
      [authorId, eventType, summary, JSON.stringify(content), importance]
    );
  } catch (err) {
    console.warn('[ResourceManager] Failed to write memory event:', err);
  }
}

// ---------------------------------------------------------------------------
// Alert + summary logic
// ---------------------------------------------------------------------------

async function checkAlerts(stats: GPUStatus[]): Promise<void> {
  for (const g of stats) {
    if (g.utilizationPct >= HIGH_UTIL_THRESHOLD && !alerted.has(g.index)) {
      alerted.add(g.index);
      await writeMemoryEvent(
        'system_alert',
        `GPU ${g.index} (${g.name}) at ${g.utilizationPct}% utilization — ${g.memoryUsedMb}/${g.memoryTotalMb} MiB used`,
        { gpu_index: g.index, gpu_name: g.name, utilization_pct: g.utilizationPct, memory_used_mb: g.memoryUsedMb, memory_free_mb: g.memoryFreeMb, temperature_c: g.temperatureC },
        4
      );
      console.warn(`[ResourceManager] ⚠ GPU ${g.index} utilization alert: ${g.utilizationPct}%`);
    } else if (g.utilizationPct < HIGH_UTIL_THRESHOLD) {
      alerted.delete(g.index);
    }
  }
}

async function writeSummary(): Promise<void> {
  if (latestStats.length === 0) return;
  const lines = latestStats.map(
    (g) =>
      `GPU${g.index} (${g.name}): ${g.utilizationPct}% util, ${g.memoryUsedMb}/${g.memoryTotalMb} MiB used` +
      (g.temperatureC !== null ? `, ${g.temperatureC}°C` : '')
  );
  await writeMemoryEvent(
    'observation',
    `GPU health summary: ${lines.join(' | ')}`,
    { gpus: latestStats, sampled_at: new Date().toISOString() },
    2
  );
  console.log('[ResourceManager] Wrote 30-min GPU summary to unified_memory');
}

// ---------------------------------------------------------------------------
// Priority queue drain — called after every poll when VRAM state is updated
// ---------------------------------------------------------------------------

function drainQueue(): void {
  if (pendingQueue.length === 0) return;

  // Sort by priority (lower number = higher priority), then by enqueue time
  pendingQueue.sort((a, b) => a.priority !== b.priority ? a.priority - b.priority : a.enqueuedAt - b.enqueuedAt);

  let dispatched = false;
  for (let i = 0; i < pendingQueue.length; i++) {
    const req = pendingQueue[i]!;
    if (canDispatchNow(req.modelName)) {
      pendingQueue.splice(i, 1);
      console.log(`[ResourceManager] GPU0: slot freed — dispatching queued request (${req.modelName})`);
      req.resolve();
      dispatched = true;
      break; // one at a time; next poll will drain more if available
    }
  }

  if (!dispatched && pendingQueue.length > 0) {
    // Nothing could be dispatched — log queue depth at debug level
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function poll(): Promise<void> {
  const stats = await querySmi();
  if (stats.length === 0) return;

  latestStats = stats;

  // Update live GPU 0 VRAM tracking
  const gpu0 = stats.find((g) => g.index === 0);
  if (gpu0) {
    currentGpu0VramUsedMB = gpu0.memoryUsedMb;
  }

  try {
    await persistStats(stats);
  } catch (err) {
    console.warn('[ResourceManager] Failed to persist GPU metrics:', err);
  }

  await checkAlerts(stats);
  drainQueue();
}

// ---------------------------------------------------------------------------
// Scheduling API
// ---------------------------------------------------------------------------

/**
 * Returns how many instances of modelName can run simultaneously on GPU 0 right now.
 * GPU1-reserved models always return 0 (never scheduled on GPU 0).
 */
export function getAvailableSlots(modelName: string): number {
  if (GPU1_RESERVED_MODELS.includes(modelName)) return 0;
  const modelVramMB = (MODEL_VRAM_GB[modelName] ?? MODEL_VRAM_GB['default']!) * 1024;
  const availableMB = GPU0_AVAILABLE_MB - currentGpu0VramUsedMB;
  return Math.max(0, Math.floor(availableMB / modelVramMB));
}

/** Returns true if at least one slot is available for modelName on GPU 0. */
export function canDispatchNow(modelName: string): boolean {
  return getAvailableSlots(modelName) > 0;
}

/** Returns the correct Ollama base URL for the given model. */
export function recommendHost(modelName: string): string {
  if (GPU1_RESERVED_MODELS.includes(modelName)) {
    return 'http://ollama-gpu1:11434'; // Alex's GPU, reserved models only
  }
  return 'http://ollama-gpu0:11434'; // shared execution pool
}

/**
 * Acquire a GPU 0 slot for modelName. Returns a Promise that resolves when
 * a slot is available. If a slot is available immediately, resolves at once.
 * Otherwise, queues the request at the given priority level.
 *
 * priority: use PRIORITY.ALEX_ROUTING | SUB_AGENT | EMBEDDING | FACTORY
 */
export function acquireSlot(modelName: string, priority: number): Promise<void> {
  const modelVramMB = (MODEL_VRAM_GB[modelName] ?? MODEL_VRAM_GB['default']!) * 1024;
  const slots = getAvailableSlots(modelName);
  const usedMB = currentGpu0VramUsedMB;
  const availableMB = GPU0_AVAILABLE_MB - usedMB;

  if (slots > 0) {
    const slotNum = (Math.floor(usedMB / modelVramMB)) + 1;
    const maxSlots = Math.floor(GPU0_AVAILABLE_MB / modelVramMB);
    console.log(`[ResourceManager] GPU0: dispatching ${modelName} (slot ${slotNum}/${maxSlots} — ${usedMB}MB/${GPU0_AVAILABLE_MB}MB used)`);
    return Promise.resolve();
  }

  console.log(`[ResourceManager] GPU0: queuing request for ${modelName} (0 slots available — ${usedMB}MB/${GPU0_AVAILABLE_MB}MB used)`);
  return new Promise<void>((resolve) => {
    pendingQueue.push({ priority, modelName, resolve, enqueuedAt: Date.now() });
  });
}

// ---------------------------------------------------------------------------
// Legacy API (backwards compatible)
// ---------------------------------------------------------------------------

/** Returns the most recent GPU snapshot. */
export function getGPUStatus(): GPUStatus[] {
  return latestStats;
}

/**
 * Returns the dual-GPU enriched status for the /api/gpu endpoint.
 */
export function getDualGPUStatus(): object {
  const gpu0 = latestStats.find((g) => g.index === 0);
  const gpu1 = latestStats.find((g) => g.index === 1);

  const smallModels = ['qwen3.5:9b', 'qwen3.5:4b', 'qwen3.5:2b'] as const;
  const gpu0AvailableSlots: Record<string, number> = {};
  for (const m of smallModels) {
    gpu0AvailableSlots[m] = getAvailableSlots(m);
  }

  return {
    gpu0: {
      vram_total_mb: gpu0?.memoryTotalMb ?? GPU0_TOTAL_VRAM_MB,
      vram_used_mb: gpu0?.memoryUsedMb ?? currentGpu0VramUsedMB,
      vram_available_mb: gpu0 ? Math.max(0, GPU0_AVAILABLE_MB - gpu0.memoryUsedMb) : GPU0_AVAILABLE_MB,
      utilization_pct: gpu0?.utilizationPct ?? 0,
      available_slots: gpu0AvailableSlots,
      queue_depth: pendingQueue.length,
      role: 'shared_execution_pool',
    },
    gpu1: {
      vram_total_mb: gpu1?.memoryTotalMb ?? 24576,
      vram_used_mb: gpu1?.memoryUsedMb ?? 0,
      vram_available_mb: gpu1 ? Math.max(0, gpu1.memoryFreeMb) : 24576,
      utilization_pct: gpu1?.utilizationPct ?? 0,
      available_slots: {},
      queue_depth: 0,
      role: 'alex_permanent_home',
    },
  };
}

/**
 * Recommends which GPU index to use for a model of the given size (GB).
 * @deprecated Use recommendHost(modelName) instead.
 */
export function recommendGPU(modelSizeGB: number): number {
  const neededMb = modelSizeGB * 1024;
  const candidates = latestStats
    .filter((g) => g.memoryFreeMb >= neededMb)
    .sort((a, b) => b.memoryFreeMb - a.memoryFreeMb);
  return candidates[0]?.index ?? -1;
}

/** @deprecated Use canDispatchNow(modelName) instead. */
export function canLoadModel(modelSizeGB: number): boolean {
  return recommendGPU(modelSizeGB) !== -1;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Starts the polling loop. Call once at process startup. */
export function startResourceManager(): void {
  console.log('[ResourceManager] Starting GPU polling (every 5s, summaries every 30m)');
  console.log(`[ResourceManager] GPU0 usable VRAM: ${GPU0_AVAILABLE_MB}MB (${GPU0_TOTAL_VRAM_MB}MB total − ${GPU0_HEADROOM_MB}MB headroom)`);
  console.log(`[ResourceManager] GPU1 reserved models: ${GPU1_RESERVED_MODELS.join(', ')}`);
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  summaryTimer = setInterval(() => void writeSummary(), SUMMARY_INTERVAL_MS);
}

/** Stops the polling loop. */
export function stopResourceManager(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
}
