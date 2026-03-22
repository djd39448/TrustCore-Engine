/**
 * Resource Manager — GPU metrics collection and routing.
 *
 * Polls nvidia-smi every 10 seconds, stores results in gpu_metrics,
 * writes high-utilization events to unified_memory, and exposes
 * helpers for routing LLM requests to the best available GPU.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { query } from '../db/client.js';

const execAsync = promisify(exec);

const POLL_INTERVAL_MS = 10_000;
const HIGH_UTIL_THRESHOLD = 80; // percent

export interface GPUStatus {
  index: number;
  name: string;
  memoryUsedMiB: number;
  memoryFreeMiB: number;
  memoryTotalMiB: number;
  utilizationPct: number;
}

let latestStats: GPUStatus[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// nvidia-smi parsing
// ---------------------------------------------------------------------------

async function querySmi(): Promise<GPUStatus[]> {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=index,name,memory.used,memory.free,memory.total,utilization.gpu --format=csv,noheader,nounits'
    );

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [idx, name, used, free, total, util] = line.split(',').map((s) => s.trim());
        return {
          index: parseInt(idx ?? '0', 10),
          name: name ?? 'unknown',
          memoryUsedMiB: parseInt(used ?? '0', 10),
          memoryFreeMiB: parseInt(free ?? '0', 10),
          memoryTotalMiB: parseInt(total ?? '0', 10),
          utilizationPct: parseInt(util ?? '0', 10),
        };
      });
  } catch {
    // nvidia-smi unavailable (CI, CPU-only host)
    return [];
  }
}

// ---------------------------------------------------------------------------
// DB + memory writes
// ---------------------------------------------------------------------------

async function persistStats(stats: GPUStatus[]): Promise<void> {
  for (const g of stats) {
    await query(
      `INSERT INTO gpu_metrics (gpu_index, gpu_name, memory_used, memory_free, memory_total, utilization)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [g.index, g.name, g.memoryUsedMiB, g.memoryFreeMiB, g.memoryTotalMiB, g.utilizationPct]
    );
  }
}

async function writeHighUtilEvent(g: GPUStatus): Promise<void> {
  try {
    const systemAgent = await query<{ id: string }>(
      `SELECT id FROM agents WHERE slug = 'system' LIMIT 1`
    );
    const authorId = systemAgent.rows[0]?.id;
    if (!authorId) return;

    await query(
      `INSERT INTO unified_memory (author_agent_id, event_type, summary, content, importance)
       VALUES ($1, 'observation', $2, $3, 4)`,
      [
        authorId,
        `GPU ${g.index} (${g.name}) utilization at ${g.utilizationPct}% — ${g.memoryUsedMiB}/${g.memoryTotalMiB} MiB used`,
        JSON.stringify({
          gpu_index: g.index,
          gpu_name: g.name,
          utilization_pct: g.utilizationPct,
          memory_used_mib: g.memoryUsedMiB,
          memory_free_mib: g.memoryFreeMiB,
          memory_total_mib: g.memoryTotalMiB,
        }),
      ]
    );
  } catch (err) {
    console.warn('[ResourceManager] Failed to write high-util event:', err);
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function poll(): Promise<void> {
  const stats = await querySmi();
  if (stats.length === 0) return;

  latestStats = stats;

  try {
    await persistStats(stats);
  } catch (err) {
    console.warn('[ResourceManager] Failed to persist GPU metrics:', err);
  }

  for (const g of stats) {
    if (g.utilizationPct >= HIGH_UTIL_THRESHOLD) {
      await writeHighUtilEvent(g);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the most recent GPU snapshot.
 */
export function getGPUStatus(): GPUStatus[] {
  return latestStats;
}

/**
 * Recommends which GPU to use for a model of the given size (in GB).
 * Returns the GPU index with the most free VRAM that can fit the model,
 * or -1 if no GPU has enough headroom.
 */
export function recommendGPU(modelSizeGB: number): number {
  const neededMiB = modelSizeGB * 1024;
  const candidates = latestStats
    .filter((g) => g.memoryFreeMiB >= neededMiB)
    .sort((a, b) => b.memoryFreeMiB - a.memoryFreeMiB);

  return candidates[0]?.index ?? -1;
}

/**
 * Starts the polling loop. Call once at process startup.
 */
export function startResourceManager(): void {
  console.log('[ResourceManager] Starting GPU polling (every 10s)');
  // Fire immediately, then on interval
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
}

/**
 * Stops the polling loop.
 */
export function stopResourceManager(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
