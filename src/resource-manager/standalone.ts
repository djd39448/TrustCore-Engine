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

console.error('[ResourceManager] Standalone process starting');
startResourceManager();

process.on('SIGINT', () => {
  console.error('\n[ResourceManager] Shutting down...');
  stopResourceManager();
  pool.end()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('[ResourceManager] Error during shutdown:', err);
      process.exit(1);
    });
});

process.on('SIGTERM', () => {
  stopResourceManager();
  pool.end()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('[ResourceManager] Error during SIGTERM shutdown:', err);
      process.exit(1);
    });
});
