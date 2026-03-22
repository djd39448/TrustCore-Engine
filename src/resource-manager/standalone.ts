/**
 * Resource Manager — standalone process entry point.
 *
 * Runs the GPU polling loop as its own container.
 * Polls nvidia-smi every 10s, writes to gpu_metrics table,
 * writes alerts and 30-min summaries to unified_memory.
 *
 * The API server reads GPU data from the database via /api/gpu.
 */

import { pool } from '../db/client.js';
import { startResourceManager, stopResourceManager } from './index.js';

console.log('[ResourceManager] Standalone process starting');
startResourceManager();

process.on('SIGINT', async () => {
  console.log('\n[ResourceManager] Shutting down...');
  stopResourceManager();
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  stopResourceManager();
  await pool.end();
  process.exit(0);
});
