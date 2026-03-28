/**
 * test-feedback-pipeline.ts — Verify the feedback/DPO pipeline end-to-end.
 */

import { pool, query } from '../src/db/client.js';
import { harvestFeedback } from '../src/agents/eval/harvester.js';
import type { EvalResult } from '../src/agents/eval/index.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main(): Promise<void> {
  console.log('\nTrustCore — Feedback/DPO Pipeline Tests');
  console.log('=========================================\n');

  // ── [1] Tables exist ──────────────────────────────────────────────────────
  console.log('[1] Table existence');

  await test('feedback table exists and is queryable', async () => {
    const r = await query('SELECT COUNT(*) FROM feedback');
    assert(r.rows.length === 1, 'Expected 1 row from COUNT(*)');
  });

  await test('training_jobs table exists and is queryable', async () => {
    const r = await query('SELECT COUNT(*) FROM training_jobs');
    assert(r.rows.length === 1, 'Expected 1 row from COUNT(*)');
  });

  await test('model_versions table exists and is queryable', async () => {
    const r = await query('SELECT COUNT(*) FROM model_versions');
    assert(r.rows.length === 1, 'Expected 1 row from COUNT(*)');
  });

  await test('eval_scores.failure_reason column exists', async () => {
    const r = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'eval_scores' AND column_name = 'failure_reason'`
    );
    assert(r.rows.length === 1, 'failure_reason column not found in eval_scores');
  });

  // ── [2] Feedback harvester writes correctly ───────────────────────────────
  console.log('\n[2] Feedback harvester');

  const agentResult = await query<{ id: string }>(
    `SELECT id FROM agents WHERE slug = 'email-writer' LIMIT 1`
  );
  const emailWriterAgentId = agentResult.rows[0]?.id;
  assert(emailWriterAgentId !== undefined, 'email-writer agent not found');

  // Create test task
  const taskResult = await query<{ id: string }>(
    `INSERT INTO tasks (created_by_agent_id, assigned_to_agent_id, title, status, result)
     VALUES (
       (SELECT id FROM agents WHERE slug = 'alex'),
       $1,
       'Pipeline test task',
       'completed',
       '{"content": "Test output for pipeline verification"}'
     ) RETURNING id`,
    [emailWriterAgentId]
  );
  const testTaskId = taskResult.rows[0]?.id;
  assert(testTaskId !== undefined, 'Failed to create test task');

  const fakeEvalApproved: EvalResult = {
    evalId: '00000000-0000-0000-0000-000000000001',
    composite_score: 4.2,
    outcome: 'approved',
    scores: {
      technical_correctness: 4.0,
      completeness: 4.5,
      brand_voice: 4.0,
      recipient_personalization: 4.0,
      clarity: 4.5,
      contextual_appropriateness: 4.5,
    },
    dimension_notes: 'Test eval — excellent output',
    improvement_suggestions: 'None',
    eval_model: 'test',
  };

  await test('harvestFeedback writes a feedback row with correct outcome', async () => {
    await harvestFeedback(testTaskId!, 'Pipeline test task', 'Test description', fakeEvalApproved);

    const r = await query<{ outcome: string; reward_score: string; prompt: string }>(
      `SELECT outcome, reward_score, prompt FROM feedback WHERE task_id = $1`,
      [testTaskId]
    );
    assert(r.rows.length === 1, `Expected 1 feedback row, got ${r.rows.length}`);
    assert(r.rows[0]!.outcome === 'approved', `Expected outcome 'approved', got '${r.rows[0]!.outcome}'`);

    const reward = parseFloat(r.rows[0]!.reward_score);
    const expected = (4.2 - 3.0) / 2.0; // = 0.6
    assert(Math.abs(reward - expected) < 0.01, `Expected reward ~${expected.toFixed(3)}, got ${reward.toFixed(3)}`);
    assert(r.rows[0]!.prompt.includes('Pipeline test task'), 'Prompt should include task title');
  });

  await test('reward_score normalized: composite 4.2 → reward 0.600', async () => {
    const r = await query<{ reward_score: string }>(
      `SELECT reward_score FROM feedback WHERE task_id = $1`,
      [testTaskId]
    );
    const reward = parseFloat(r.rows[0]!.reward_score);
    assert(Math.abs(reward - 0.6) < 0.01, `Expected 0.600, got ${reward.toFixed(3)}`);
  });

  // Test approved_with_edits (composite 3.5)
  const taskResult2 = await query<{ id: string }>(
    `INSERT INTO tasks (created_by_agent_id, assigned_to_agent_id, title, status, result)
     VALUES (
       (SELECT id FROM agents WHERE slug = 'alex'),
       $1,
       'Pipeline test task 2',
       'completed',
       '{"content": "Adequate output"}'
     ) RETURNING id`,
    [emailWriterAgentId]
  );
  const testTaskId2 = taskResult2.rows[0]?.id;
  assert(testTaskId2 !== undefined, 'Failed to create test task 2');

  await test('harvestFeedback: composite 3.5 → approved_with_edits, reward 0.250', async () => {
    const evalEdits: EvalResult = { ...fakeEvalApproved, composite_score: 3.5, outcome: 'needs_review' };
    await harvestFeedback(testTaskId2!, 'Pipeline test task 2', null, evalEdits);

    const r = await query<{ outcome: string; reward_score: string }>(
      `SELECT outcome, reward_score FROM feedback WHERE task_id = $1`,
      [testTaskId2]
    );
    assert(r.rows.length === 1, 'Expected 1 feedback row');
    assert(r.rows[0]!.outcome === 'approved_with_edits', `Expected 'approved_with_edits', got '${r.rows[0]!.outcome}'`);
    const reward = parseFloat(r.rows[0]!.reward_score);
    assert(Math.abs(reward - 0.25) < 0.01, `Expected reward 0.250, got ${reward.toFixed(3)}`);
  });

  // ── [3] checkRetrainingThresholds queries work ────────────────────────────
  console.log('\n[3] Retraining threshold infrastructure');

  await test('feedback table queryable for unused training rows', async () => {
    const r = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM feedback WHERE used_in_training = false`
    );
    const cnt = parseInt(r.rows[0]?.cnt ?? '0', 10);
    assert(cnt >= 0, 'Expected non-negative count');
  });

  await test('training_jobs table queryable for queued jobs', async () => {
    const r = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM training_jobs WHERE status = 'queued'`
    );
    const cnt = parseInt(r.rows[0]?.cnt ?? '0', 10);
    assert(cnt >= 0, 'Expected non-negative count');
  });

  await test('approval rate query runs correctly', async () => {
    const r = await query<{ total: string; approved: string }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE outcome = 'approved') AS approved
       FROM eval_scores
       WHERE created_at >= NOW() - INTERVAL '30 days'
         AND calibration_void = false`
    );
    assert(r.rows.length === 1, 'Expected 1 row from approval rate query');
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await query('DELETE FROM feedback WHERE task_id IN ($1, $2)', [testTaskId, testTaskId2]);
  await query('DELETE FROM tasks WHERE id IN ($1, $2)', [testTaskId, testTaskId2]);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n=========================================');
  console.log(`Results: ${passed} passed, ${failed} failed\n`);

  await pool.end();

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
