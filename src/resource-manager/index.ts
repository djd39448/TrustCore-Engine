/**
 * Resource Manager — GPU metrics collection and LLM inference routing.
 *
 * TrustCore runs two RTX 3090 GPUs:
 *   GPU 0 — dedicated to training (factory) + agent inference when available
 *   GPU 1 — handles display + system + agent inference
 *
 * This service:
 *   1. Polls nvidia-smi every 10 seconds for VRAM/util/temp on both GPUs
 *   2. Stores metrics in gpu_metrics table
 *   3. Exposes recommendGPU(modelSizeGB) for routing decisions
 *   4. Exposes canLoadModel(modelSizeGB) to check headroom
 *   5. Writes system_alert to unified_memory when GPU util > 80%
 *   6. Writes observation summary to unified_memory every 30 minutes
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { query } from '../db/client.js';

const execAsync = promisify(exec);

const POLL_INTERVAL_MS = 10_000;
const SUMMARY_INTERVAL_MS = 30 * 60_000;
const HIGH_UTIL_THRESHOLD = 80; // percent

export interface GPUStatus {
  index: number;
  name: string;
  memoryUsedMb: number;
  memoryFreeMb: number;
  memoryTotalMb: number;
  utilizationPct: number;
  temperatureC: number | null;
}

let latestStats: GPUStatus[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let summaryTimer: ReturnType<typeof setInterval> | null = null;
const alerted = new Set<number>(); // GPU indexes currently in alert state

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
    // nvidia-smi unavailable — return mock data with clear warning
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
      alerted.delete(g.index); // clear alert state when util drops
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

  await checkAlerts(stats);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns the most recent GPU snapshot. */
export function getGPUStatus(): GPUStatus[] {
  return latestStats;
}

/**
 * Recommends which GPU index to use for a model of the given size (GB).
 * Returns the GPU with the most free VRAM that can fit the model, or -1.
 */
export function recommendGPU(modelSizeGB: number): number {
  const neededMb = modelSizeGB * 1024;
  const candidates = latestStats
    .filter((g) => g.memoryFreeMb >= neededMb)
    .sort((a, b) => b.memoryFreeMb - a.memoryFreeMb);
  return candidates[0]?.index ?? -1;
}

/** Returns true if at least one GPU has enough free VRAM for the model. */
export function canLoadModel(modelSizeGB: number): boolean {
  return recommendGPU(modelSizeGB) !== -1;
}

/** Starts the polling loop. Call once at process startup. */
export function startResourceManager(): void {
  console.log('[ResourceManager] Starting GPU polling (every 10s, summaries every 30m)');
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  summaryTimer = setInterval(() => void writeSummary(), SUMMARY_INTERVAL_MS);
}

/** Stops the polling loop. */
export function stopResourceManager(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
}
