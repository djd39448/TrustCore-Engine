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
 */

import express from 'express';
import { evaluate, type EvalInput } from './index.js';

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
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Eval Server] evaluate() threw:', message);
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`[Eval Server] Listening on :${PORT}`);
  console.log(`[Eval Server] OLLAMA_HOST=${process.env['OLLAMA_HOST'] ?? 'localhost:11434'}`);
});
