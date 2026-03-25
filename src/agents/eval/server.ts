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
import { writeUnifiedMemory, writeOwnMemory } from '../../mcp/tools.js';
import { query } from '../../db/client.js';

const PORT = parseInt(process.env['EVAL_PORT'] ?? '3005');

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

    // Write eval result to unified_memory so it surfaces in the shared activity feed
    const importance = result.outcome === 'approved' ? 2
      : result.outcome === 'needs_review' ? 3
      : 4; // needs_revision

    const summary = `Eval complete: ${input.taskTitle} — composite ${result.composite_score.toFixed(2)} → ${result.outcome}`;
    const memContent = {
      task_id: input.taskId,
      composite_score: result.composite_score,
      outcome: result.outcome,
      top_suggestion: result.improvement_suggestions,
    };

    writeUnifiedMemory('eval', 'observation', summary, memContent, importance).catch((err: unknown) => {
      console.error('[Eval Server] Failed to write unified_memory:', err instanceof Error ? err.message : String(err));
    });

    // Write to agent_memory so eval appears in the Individual memory tab
    writeOwnMemory('eval', 'workflow_step', summary, {
      ...memContent,
      scores: result.scores,
      eval_id: result.evalId,
    }, importance).catch((err: unknown) => {
      console.error('[Eval Server] Failed to write agent_memory:', err instanceof Error ? err.message : String(err));
    });

    // Signal that the eval agent is returning to idle — releases the gpu0 VRAM slot.
    // Importance=2 keeps it low-noise; the message format is intentionally
    // machine-readable so Alex's double-dispatch guard can query for it.
    writeUnifiedMemory(
      'eval',
      'observation',
      '[eval] Scoring complete — returning to idle',
      { task_id: input.taskId, eval_id: result.evalId, status: 'idle' },
      2
    ).catch((err: unknown) => {
      console.error('[Eval Server] Failed to write idle event:', err instanceof Error ? err.message : String(err));
    });

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Eval Server] evaluate() threw:', message);
    res.status(500).json({ error: message });
  }
});

async function sendHeartbeat(): Promise<void> {
  const ts = new Date().toISOString();
  try {
    await query(`UPDATE agents SET last_seen = NOW() WHERE slug = 'eval'`);
    console.error(`[Eval Server] Heartbeat at ${ts}`);
  } catch (err) {
    console.error('[Eval Server] Heartbeat failed:', err instanceof Error ? err.message : String(err));
  }
}

app.listen(PORT, () => {
  console.error(`[Eval Server] Listening on :${PORT}`);
  console.error(`[Eval Server] OLLAMA_HOST=${process.env['OLLAMA_HOST'] ?? 'localhost:11434'}`);

  sendHeartbeat().catch((err: unknown) => {
    console.error('[Eval Server] Initial heartbeat error:', err instanceof Error ? err.message : String(err));
  });
  setInterval(() => {
    sendHeartbeat().catch((err: unknown) => {
      console.error('[Eval Server] Heartbeat interval error:', err instanceof Error ? err.message : String(err));
    });
  }, 60_000);
});
