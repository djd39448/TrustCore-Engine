/**
 * quality-gate.ts — Model promotion quality gate for the training factory.
 *
 * Runs after any training round completes to decide whether the newly trained
 * model should replace the current production model.
 *
 * Gate logic:
 *   1. Read the new model's benchmark_scores from model_versions
 *   2. Read the current production model's benchmark_scores
 *   3. Compare all metrics — new model must be EQUAL OR BETTER on ALL dimensions
 *   4. Pass → promote new model to production, demote old, write 'model_promoted' event
 *   5. Fail → discard new model, keep current production, write 'model_rejected' event
 *
 * Called by the factory after training completes. The factory owns the
 * training_jobs row — quality gate only reads it and updates the model
 * promotion status.
 */

import { query } from '../db/client.js';
import { writeUnifiedMemory } from '../mcp/tools.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityGateInput {
  /** UUID of the newly trained model version to evaluate */
  newModelVersionId: string;
  /** UUID of the training_jobs row that produced this model */
  trainingJobId: string;
}

export type QualityGateOutcome = 'promoted' | 'discarded';

export interface QualityGateResult {
  outcome: QualityGateOutcome;
  newModelId: string;
  previousModelId: string | null;
  /** Metrics where the new model was worse (empty on promotion) */
  failedMetrics: string[];
  newScores: Record<string, number>;
  baselineScores: Record<string, number> | null;
}

// ---------------------------------------------------------------------------
// runQualityGate
// ---------------------------------------------------------------------------

/**
 * Evaluates a newly trained model and promotes or discards it.
 *
 * @param input   { newModelVersionId, trainingJobId }
 * @returns       QualityGateResult with outcome, metric comparison, and IDs
 */
export async function runQualityGate(input: QualityGateInput): Promise<QualityGateResult> {
  const { newModelVersionId, trainingJobId } = input;

  // ── Step 1: Fetch the new model version ─────────────────────────────────
  const newModelRow = await query<{
    id: string;
    agent_id: string;
    benchmark_scores: Record<string, number> | null;
    version_number: number;
  }>(
    `SELECT id, agent_id, benchmark_scores, version_number
     FROM model_versions
     WHERE id = $1`,
    [newModelVersionId],
  );

  if (newModelRow.rows.length === 0) {
    throw new Error(`[QualityGate] model_version ${newModelVersionId} not found`);
  }

  const newModel = newModelRow.rows[0]!;

  if (!newModel.benchmark_scores || Object.keys(newModel.benchmark_scores).length === 0) {
    throw new Error(`[QualityGate] model_version ${newModelVersionId} has no benchmark_scores`);
  }

  const newScores = newModel.benchmark_scores;

  // ── Step 2: Fetch current production model ───────────────────────────────
  const currentProdRow = await query<{
    id: string;
    benchmark_scores: Record<string, number> | null;
    version_number: number;
  }>(
    `SELECT id, benchmark_scores, version_number
     FROM model_versions
     WHERE agent_id = $1
       AND is_production = true
       AND id != $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [newModel.agent_id, newModelVersionId],
  );

  const currentProd = currentProdRow.rows[0] ?? null;
  const baselineScores = currentProd?.benchmark_scores ?? null;

  // ── Step 3: Compare metrics ──────────────────────────────────────────────
  // New model must be >= baseline on ALL shared metrics.
  // If no current production model exists, the new model is promoted unconditionally
  // (it becomes the first production model for this agent).
  const failedMetrics: string[] = [];

  if (baselineScores) {
    for (const [metric, baselineValue] of Object.entries(baselineScores)) {
      const newValue = newScores[metric];
      if (newValue === undefined) {
        // New model is missing a metric the baseline had — this is a regression
        failedMetrics.push(`${metric} (missing in new model)`);
        continue;
      }
      if (newValue < baselineValue) {
        failedMetrics.push(`${metric}: ${newValue.toFixed(4)} < baseline ${baselineValue.toFixed(4)}`);
      }
    }
  }

  const passed = failedMetrics.length === 0;
  const outcome: QualityGateOutcome = passed ? 'promoted' : 'discarded';

  // ── Step 4 / 5: Execute outcome ──────────────────────────────────────────
  if (passed) {
    // Promote new model
    await query(
      `UPDATE model_versions SET is_production = true WHERE id = $1`,
      [newModelVersionId],
    );

    // Demote old production model if one existed
    if (currentProd) {
      await query(
        `UPDATE model_versions SET is_production = false WHERE id = $1`,
        [currentProd.id],
      );
    }

    // Update training job status
    await query(
      `UPDATE training_jobs SET status = 'promoted', promoted = true, completed_at = NOW() WHERE id = $1`,
      [trainingJobId],
    );

    await writeUnifiedMemory(
      'alex',
      'observation',
      `model_promoted: agent ${newModel.agent_id} v${newModel.version_number} passed quality gate`,
      {
        new_model_id: newModelVersionId,
        previous_model_id: currentProd?.id ?? null,
        new_version: newModel.version_number,
        new_scores: newScores,
        baseline_scores: baselineScores,
        training_job_id: trainingJobId,
      },
      4,
    );

    console.error(`[QualityGate] PROMOTED model ${newModelVersionId} (v${newModel.version_number})`);
  } else {
    // Discard new model
    await query(
      `UPDATE model_versions SET is_production = false WHERE id = $1`,
      [newModelVersionId],
    );

    // Update training job status
    await query(
      `UPDATE training_jobs SET status = 'discarded', promoted = false, completed_at = NOW() WHERE id = $1`,
      [trainingJobId],
    );

    await writeUnifiedMemory(
      'alex',
      'observation',
      `model_rejected: agent ${newModel.agent_id} v${newModel.version_number} failed quality gate — ${failedMetrics.length} metric(s) worse`,
      {
        new_model_id: newModelVersionId,
        training_job_id: trainingJobId,
        failed_metrics: failedMetrics,
        new_scores: newScores,
        baseline_scores: baselineScores,
      },
      3,
    );

    console.error(`[QualityGate] DISCARDED model ${newModelVersionId} — failed: ${failedMetrics.join(', ')}`);
  }

  return {
    outcome,
    newModelId: newModelVersionId,
    previousModelId: currentProd?.id ?? null,
    failedMetrics,
    newScores,
    baselineScores,
  };
}
