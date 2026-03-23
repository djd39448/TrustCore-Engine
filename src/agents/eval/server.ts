/**
 * Eval Agent — standalone HTTP server.
 *
 * Runs as trustcore-eval container on port 3005 (default).
 * Alex calls POST /eval instead of importing evaluate() directly.
 * This allows the eval agent to use its own Ollama instance (gpu0)
 * with qwen2.5:7b, independent of Alex's gpu1/14b setup.
 *
 * Endpoints:
 *   GET  /health      → { status: 'ok', service: 'eval' }
 *   POST /eval        → EvalResult | 500 error
 *
 * Also:
 *   - Writes to unified_memory after every eval score (Fix 2)
 *   - Sends a heartbeat to unified_memory every 60s (Fix 3)
 */

import express from 'express';
import { evaluate, type EvalInput } from './index.js';
import { writeUnifiedMemory } from '../../mcp/tools.js';

const PORT = parseInt(process.env['EVAL_PORT'] ?? '3005');
const HEARTBEAT_INTERVAL_MS = 60_000;

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'eval', port: PORT });
});

app.post('/eval', async (req, res) => {
  const input = req.body as EvalInput;

  if (
    typeof input?.taskId !== 'string' ||
    typeof input?.taskTitle !== 'string' ||
    typeof input?.producerAgentSlug !== 'string' ||
    input?.result === undefined
  ) {
    res.status(400).json({
      error: 'Missing required fields: taskId, taskTitle, producerAgentSlug, result',
    });
    return;
  }

  try {
    const result = await evaluate(input);

    // Fix 2 — write eval result to unified_memory so it surfaces in the activity feed
    const importance = result.outcome === 'approved' ? 2
      : result.outcome === 'needs_review' ? 3
      : 4; // needs_revision

    writeUnifiedMemory(
      'eval',
      'observation',
      `Eval complete: ${input.taskTitle} — composite ${result.composite_score.toFixed(2)} → ${result.outcome}`,
      {
        task_id: input.taskId,
        composite_score: result.composite_score,
        outcome: result.outcome,
        top_suggestion: result.improvement_suggestions,
      },
      importance
    ).catch((err: unknown) => {
      console.error('[Eval Server] Failed to write unified_memory:', err instanceof Error ? err.message : String(err));
    });

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Eval Server] evaluate() threw:', message);
    res.status(500).json({ error: message });
  }
});

// Fix 3 — heartbeat so eval shows as alive in the Team sidebar
async function sendHeartbeat(): Promise<void> {
  const ts = new Date().toISOString();
  try {
    await writeUnifiedMemory(
      'eval',
      'heartbeat',
      `Eval agent heartbeat — system alive at ${ts}`,
      { ts, agent: 'eval' },
      1
    );
    console.log(`[Eval Server] Heartbeat at ${ts}`);
  } catch (err) {
    console.error('[Eval Server] Heartbeat failed:', err instanceof Error ? err.message : String(err));
  }
}

app.listen(PORT, async () => {
  console.log(`[Eval Server] Listening on :${PORT}`);
  console.log(`[Eval Server] OLLAMA_HOST=${process.env['OLLAMA_HOST'] ?? 'localhost:11434'}`);

  // Send first heartbeat immediately, then every 60s
  await sendHeartbeat();
  setInterval(() => {
    sendHeartbeat().catch((err: unknown) => {
      console.error('[Eval Server] Heartbeat interval error:', err instanceof Error ? err.message : String(err));
    });
  }, HEARTBEAT_INTERVAL_MS);
});
