/**
 * test-quality-gate.ts — Unit tests for the training factory quality gate.
 *
 * Tests:
 *   1. Pass case: new model equal or better on all metrics → promoted
 *   2. Fail case: new model worse on at least one metric → discarded
 */

import { pool, query } from '../src/db/client.js';
import { runQualityGate } from '../src/factory/quality-gate.js';

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
  console.log('\nTrustCore — Quality Gate Unit Tests');
  console.log('=====================================\n');

  // Use the eval agent (always present) as the test subject
  const agentResult = await query<{ id: string }>(
    `SELECT id FROM agents WHERE slug = 'eval' LIMIT 1`
  );
  const testAgentId = agentResult.rows[0]?.id;
  assert(testAgentId !== undefined, 'eval agent not found in DB');

  // Track IDs for cleanup
  const jobIds: string[] = [];
  const modelIds: string[] = [];

  // ── [1] Pass case ─────────────────────────────────────────────────────────
  console.log('[1] Quality gate — pass case (new model equal or better on all metrics)');

  // benchmark_scores use higher-is-better metrics only (gate uses >= for all)
  // Create current production model
  const prodModelResult = await query<{ id: string }>(
    `INSERT INTO model_versions
       (agent_id, version_number, benchmark_scores, is_production)
     VALUES ($1, 100, $2, true)
     RETURNING id`,
    [testAgentId, JSON.stringify({ accuracy: 0.75, f1: 0.70, bleu: 0.60 })]
  );
  const prodModelId = prodModelResult.rows[0]?.id!;
  modelIds.push(prodModelId);

  // Create new model (BETTER on all metrics — all higher)
  const newModelPassResult = await query<{ id: string }>(
    `INSERT INTO model_versions
       (agent_id, version_number, benchmark_scores, is_production)
     VALUES ($1, 101, $2, false)
     RETURNING id`,
    [testAgentId, JSON.stringify({ accuracy: 0.82, f1: 0.78, bleu: 0.67 })]
  );
  const newModelPassId = newModelPassResult.rows[0]?.id!;
  modelIds.push(newModelPassId);

  const passJobResult = await query<{ id: string }>(
    `INSERT INTO training_jobs (agent_id, trigger_type, trigger_value, status)
     VALUES ($1, 'manual', 0, 'evaluating')
     RETURNING id`,
    [testAgentId]
  );
  const passJobId = passJobResult.rows[0]?.id!;
  jobIds.push(passJobId);

  await test('new model promoted when all numeric metrics are >= baseline', async () => {
    const result = await runQualityGate({
      newModelVersionId: newModelPassId,
      trainingJobId: passJobId,
    });
    assert(result.outcome === 'promoted', `Expected 'promoted', got '${result.outcome}'`);
    assert(result.failedMetrics.length === 0, `Unexpected failed metrics: ${result.failedMetrics.join(', ')}`);
    assert(result.newModelId === newModelPassId, 'newModelId mismatch');
    assert(result.previousModelId === prodModelId, 'previousModelId mismatch');
  });

  await test('pass: new model is_production=true in DB after promotion', async () => {
    const r = await query<{ is_production: boolean }>(
      `SELECT is_production FROM model_versions WHERE id = $1`, [newModelPassId]
    );
    assert(r.rows[0]?.is_production === true, 'New model should be is_production=true');
  });

  await test('pass: old model is_production=false in DB after demotion', async () => {
    const r = await query<{ is_production: boolean }>(
      `SELECT is_production FROM model_versions WHERE id = $1`, [prodModelId]
    );
    assert(r.rows[0]?.is_production === false, 'Old model should be is_production=false');
  });

  await test('pass: training_job.status = "promoted"', async () => {
    const r = await query<{ status: string; promoted: boolean }>(
      `SELECT status, promoted FROM training_jobs WHERE id = $1`, [passJobId]
    );
    assert(r.rows[0]?.status === 'promoted', `Expected 'promoted', got '${r.rows[0]?.status}'`);
    assert(r.rows[0]?.promoted === true, 'promoted flag should be true');
  });

  // ── [2] Fail case ─────────────────────────────────────────────────────────
  console.log('\n[2] Quality gate — fail case (new model worse on f1)');

  // Create new model that is WORSE on f1 (now compared against newModelPassId which is production)
  const newModelFailResult = await query<{ id: string }>(
    `INSERT INTO model_versions
       (agent_id, version_number, benchmark_scores, is_production)
     VALUES ($1, 102, $2, false)
     RETURNING id`,
    [testAgentId, JSON.stringify({ accuracy: 0.85, f1: 0.65, bleu: 0.70 })]
    // f1 = 0.65 < 0.78 (current production after pass) — this should FAIL
  );
  const newModelFailId = newModelFailResult.rows[0]?.id!;
  modelIds.push(newModelFailId);

  const failJobResult = await query<{ id: string }>(
    `INSERT INTO training_jobs (agent_id, trigger_type, trigger_value, status)
     VALUES ($1, 'manual', 0, 'evaluating')
     RETURNING id`,
    [testAgentId]
  );
  const failJobId = failJobResult.rows[0]?.id!;
  jobIds.push(failJobId);

  await test('new model discarded when a metric is worse', async () => {
    const result = await runQualityGate({
      newModelVersionId: newModelFailId,
      trainingJobId: failJobId,
    });
    assert(result.outcome === 'discarded', `Expected 'discarded', got '${result.outcome}'`);
    assert(result.failedMetrics.length > 0, 'Expected at least one failed metric');
    const hasF1 = result.failedMetrics.some(m => m.includes('f1'));
    assert(hasF1, `Expected f1 in failed metrics, got: ${result.failedMetrics.join(', ')}`);
  });

  await test('fail: discarded model remains is_production=false', async () => {
    const r = await query<{ is_production: boolean }>(
      `SELECT is_production FROM model_versions WHERE id = $1`, [newModelFailId]
    );
    assert(r.rows[0]?.is_production === false, 'Discarded model should stay is_production=false');
  });

  await test('fail: training_job.status = "discarded"', async () => {
    const r = await query<{ status: string; promoted: boolean }>(
      `SELECT status, promoted FROM training_jobs WHERE id = $1`, [failJobId]
    );
    assert(r.rows[0]?.status === 'discarded', `Expected 'discarded', got '${r.rows[0]?.status}'`);
    assert(r.rows[0]?.promoted === false, 'promoted flag should be false');
  });

  // ── [3] Edge case: no existing production model → always promote ──────────
  console.log('\n[3] Edge case — no existing production model');

  // Use a fresh training job + a new model with no competing production model
  // First ensure newModelPassId is production (it should be after pass test)
  // Use a new isolated agent slug approach is not possible, so we test by
  // temporarily setting all models to non-production for a separate check
  // Instead, just verify the gate logic handles null previousModelId gracefully
  await test('gate returns correct previousModelId=null when no prior production exists', async () => {
    // Set newModelPassId back to is_production=false for this test
    await query(`UPDATE model_versions SET is_production = false WHERE agent_id = $1`, [testAgentId]);

    const soloModel = await query<{ id: string }>(
      `INSERT INTO model_versions
         (agent_id, version_number, benchmark_scores, is_production)
       VALUES ($1, 103, $2, false)
       RETURNING id`,
      [testAgentId, JSON.stringify({ accuracy: 0.70, f1: 0.65 })]
    );
    const soloModelId = soloModel.rows[0]?.id!;
    modelIds.push(soloModelId);

    const soloJob = await query<{ id: string }>(
      `INSERT INTO training_jobs (agent_id, trigger_type, trigger_value, status)
       VALUES ($1, 'manual', 0, 'evaluating')
       RETURNING id`,
      [testAgentId]
    );
    const soloJobId = soloJob.rows[0]?.id!;
    jobIds.push(soloJobId);

    const result = await runQualityGate({
      newModelVersionId: soloModelId,
      trainingJobId: soloJobId,
    });

    assert(result.outcome === 'promoted', `Expected 'promoted' with no baseline, got '${result.outcome}'`);
    assert(result.previousModelId === null, `Expected previousModelId=null, got '${result.previousModelId}'`);
    assert(result.failedMetrics.length === 0, 'Expected no failed metrics when no baseline');
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await query(
    `DELETE FROM training_jobs WHERE id = ANY($1::uuid[])`,
    [jobIds]
  );
  await query(
    `DELETE FROM model_versions WHERE id = ANY($1::uuid[])`,
    [modelIds]
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n=====================================');
  console.log(`Results: ${passed} passed, ${failed} failed\n`);

  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
