/**
 * harvester.ts — Feedback harvester for the DPO training pipeline.
 *
 * Runs after every task completion (called from Alex's checkCompletedDelegations()
 * after eval scoring). Converts each eval result into a feedback record — the raw
 * signal the training factory uses to build DPO preference pairs.
 *
 * Process:
 *   1. Read the eval score for the completed child task from eval_scores
 *   2. Read the task result from tasks.result
 *   3. Determine outcome from composite score:
 *        composite >= 4.0 → 'approved'
 *        composite >= 3.0 → 'approved_with_edits'
 *        composite  < 3.0 → 'rejected'
 *   4. Write a row to the feedback table with:
 *        prompt:       task title + description + enrichment block
 *        output:       tasks.result (stringified)
 *        outcome:      determined above
 *        reward_score: normalized composite score mapped to [-1, 1]
 *   5. Log to unified_memory: "Feedback recorded for task {id}, outcome: {outcome}, reward: {score}"
 *
 * Reward score normalization:
 *   composite is in [1.0, 5.0]. We map this to [-1, 1]:
 *     reward = (composite - 3.0) / 2.0
 *   This gives:
 *     5.0 → +1.0   (perfect)
 *     3.0 →  0.0   (neutral)
 *     1.0 → -1.0   (worst)
 */

import { query } from '../../db/client.js';
import { writeUnifiedMemory } from '../../mcp/tools.js';
import type { EvalResult } from './index.js';

/**
 * Records a feedback row for a completed, evaluated task.
 *
 * @param taskId         UUID of the child task that completed
 * @param parentTitle    Title of the parent task (used as prompt prefix)
 * @param parentDesc     Description of the parent task
 * @param evalResult     The eval result returned by the eval service
 *
 * Non-fatal: errors are logged and swallowed so a harvester failure never
 * blocks task completion.
 */
export async function harvestFeedback(
  taskId: string,
  parentTitle: string,
  parentDesc: string | null,
  evalResult: EvalResult,
): Promise<void> {
  try {
    // ── Step 1: Fetch the task result and agent ──────────────────────────────
    const taskRow = await query<{
      result: unknown;
      assigned_to_agent_id: string | null;
    }>(
      `SELECT result, assigned_to_agent_id FROM tasks WHERE id = $1`,
      [taskId],
    );

    if (taskRow.rows.length === 0) {
      console.error(`[Harvester] Task ${taskId} not found — skipping feedback`);
      return;
    }

    const { result, assigned_to_agent_id } = taskRow.rows[0]!;

    if (!assigned_to_agent_id) {
      console.error(`[Harvester] Task ${taskId} has no assigned agent — skipping feedback`);
      return;
    }

    // ── Step 2: Determine outcome from composite score ───────────────────────
    const composite = evalResult.composite_score;
    let outcome: 'approved' | 'approved_with_edits' | 'rejected';
    if (composite >= 4.0) {
      outcome = 'approved';
    } else if (composite >= 3.0) {
      outcome = 'approved_with_edits';
    } else {
      outcome = 'rejected';
    }

    // ── Step 3: Build prompt and output strings ──────────────────────────────
    // The prompt is the full task specification — everything a human (or model)
    // would need to reproduce this task from scratch.
    const promptParts: string[] = [`Task: ${parentTitle}`];
    if (parentDesc) {
      promptParts.push(`Description: ${parentDesc}`);
    }
    const prompt = promptParts.join('\n\n');

    // Serialize the task result to a string for storage.
    const output = typeof result === 'string'
      ? result
      : JSON.stringify(result, null, 2);

    // ── Step 4: Compute normalized reward score ──────────────────────────────
    // composite ∈ [1.0, 5.0] → reward ∈ [-1.0, 1.0]
    // formula: (composite - 3.0) / 2.0
    const rewardScore = (composite - 3.0) / 2.0;

    // ── Step 5: Insert feedback row ──────────────────────────────────────────
    await query(
      `INSERT INTO feedback
         (agent_id, task_id, prompt, output, outcome, reward_score)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        assigned_to_agent_id,
        taskId,
        prompt,
        output,
        outcome,
        rewardScore,
      ],
    );

    // ── Step 6: Log to unified_memory ────────────────────────────────────────
    await writeUnifiedMemory(
      'alex',
      'observation',
      `Feedback recorded for task ${taskId}, outcome: ${outcome}, reward: ${rewardScore.toFixed(3)}`,
      {
        task_id: taskId,
        agent_id: assigned_to_agent_id,
        outcome,
        reward_score: rewardScore,
        composite_score: composite,
      },
      2,
    );

    console.error(`[Harvester] Feedback recorded — task ${taskId}, outcome: ${outcome}, reward: ${rewardScore.toFixed(3)}`);
  } catch (err) {
    // Harvester failure is non-fatal — task completion must not be blocked.
    console.error(`[Harvester] Error recording feedback for task ${taskId}:`, err instanceof Error ? err.message : String(err));
  }
}
