/**
 * Eval Agent — multi-dimensional output quality scorer.
 *
 * NOT a polling SubAgent. Called directly by Alex (or tests) via evaluate().
 *
 * Dimensions (1.0–5.0 scale, weighted composite):
 *   technical_correctness      15%
 *   completeness               20%
 *   brand_voice                20%
 *   recipient_personalization  20%
 *   clarity                    15%
 *   contextual_appropriateness 10%
 *
 * Outcomes:
 *   composite ≥ 3.5 → approved
 *   composite 2.5–3.49 → needs_review
 *   composite < 2.5  → needs_revision
 */

import { query } from '../../db/client.js';
import { searchKnowledgeBase, resolveAgentId } from '../../mcp/tools.js';
import { chat } from '../../llm/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalInput {
  taskId: string;
  taskTitle: string;
  taskDescription: string | null;
  producerAgentSlug: string; // slug of agent that produced the output
  result: unknown;           // raw task result to evaluate
  revisionNumber?: number;   // 0 for first eval, 1+ for retries
  previousEvalId?: string;   // self-referential chain
}

export interface DimensionScores {
  technical_correctness: number;
  completeness: number;
  brand_voice: number;
  recipient_personalization: number;
  clarity: number;
  contextual_appropriateness: number;
}

export interface EvalResult {
  evalId: string;
  composite_score: number;
  outcome: 'approved' | 'needs_review' | 'needs_revision';
  scores: DimensionScores;
  dimension_notes: string;
  improvement_suggestions: string;
  eval_model: string;
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

const WEIGHTS: Record<keyof DimensionScores, number> = {
  technical_correctness:      0.15,
  completeness:               0.20,
  brand_voice:                0.20,
  recipient_personalization:  0.20,
  clarity:                    0.15,
  contextual_appropriateness: 0.10,
};

const EVAL_MODEL = 'qwen2.5:7b';
const EVAL_PRIORITY = 2;

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

const EVAL_SYSTEM = `You are an expert quality evaluator for AI-generated task outputs.
Score the output on 6 dimensions, each on a scale of 1.0 to 5.0 (one decimal place).
Respond ONLY with valid JSON matching this exact schema — no prose, no markdown:

{
  "technical_correctness": <1.0-5.0>,
  "completeness": <1.0-5.0>,
  "brand_voice": <1.0-5.0>,
  "recipient_personalization": <1.0-5.0>,
  "clarity": <1.0-5.0>,
  "contextual_appropriateness": <1.0-5.0>,
  "dimension_notes": "<brief notes on each dimension>",
  "improvement_suggestions": "<specific suggestions for dimensions scoring below 3.0, or 'None' if all pass>"
}

Scoring guide:
5.0 = Excellent — exceeds expectations
4.0 = Good — meets expectations with minor issues
3.0 = Adequate — meets minimum bar but could improve
2.0 = Poor — significant problems
1.0 = Failing — does not meet requirements`;

// ---------------------------------------------------------------------------
// Main evaluate() entry point
// ---------------------------------------------------------------------------

export async function evaluate(input: EvalInput): Promise<EvalResult> {
  const {
    taskId,
    taskTitle,
    taskDescription,
    producerAgentSlug,
    result,
    revisionNumber = 0,
    previousEvalId,
  } = input;

  console.log(`[Eval] Evaluating task ${taskId} (rev ${revisionNumber})`);

  // --- Pull context for personalization scoring + calibration examples ---
  const [recipientContext, brandVoiceContext, calibrationContext] = await Promise.all([
    fetchRecipientContext(taskTitle),
    fetchBrandVoiceContext(taskTitle),
    fetchCalibrationContext(taskTitle),
  ]);

  if (calibrationContext.isFirstOfType) {
    console.log(`[Eval] First eval of this task type — no calibration anchors yet`);
  } else {
    console.log(`[Eval] Loaded ${calibrationContext.examples.length} calibration example(s)`);
  }

  // --- Build evaluation prompt ---
  const resultText = typeof result === 'string'
    ? result
    : JSON.stringify(result, null, 2);

  const userPrompt = buildEvalPrompt(
    taskTitle,
    taskDescription,
    resultText,
    recipientContext,
    brandVoiceContext,
    calibrationContext
  );

  // --- Call LLM ---
  const rawResponse = await chat(
    [{ role: 'user', content: userPrompt }],
    EVAL_MODEL,
    EVAL_PRIORITY,
    `eval:${taskId}`
  );

  // --- Parse response ---
  const parsed = parseEvalResponse(rawResponse);

  // --- Compute weighted composite ---
  const composite = computeComposite(parsed.scores);
  const outcome = determineOutcome(composite);

  // --- Persist to DB ---
  const evalId = await persistEval({
    taskId,
    producerAgentSlug,
    scores: parsed.scores,
    composite,
    outcome,
    dimension_notes: parsed.dimension_notes,
    improvement_suggestions: parsed.improvement_suggestions,
    revisionNumber,
    previousEvalId,
    eval_model: EVAL_MODEL,
  });

  console.log(`[Eval] Task ${taskId} → composite ${composite.toFixed(2)} → ${outcome} (eval ${evalId})`);

  return {
    evalId,
    composite_score: composite,
    outcome,
    scores: parsed.scores,
    dimension_notes: parsed.dimension_notes,
    improvement_suggestions: parsed.improvement_suggestions,
    eval_model: EVAL_MODEL,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Calibration context: load previous evals of similar task types
// ---------------------------------------------------------------------------

interface CalibrationExample {
  composite_score: number;
  outcome: string;
  dimension_notes: string;
  task_title: string;
}

interface CalibrationContext {
  isFirstOfType: boolean;
  examples: CalibrationExample[];
}

async function fetchCalibrationContext(taskTitle: string): Promise<CalibrationContext> {
  try {
    // Extract significant words from the title to search for similar task types
    const words = taskTitle
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 5);

    if (words.length === 0) {
      return { isFirstOfType: true, examples: [] };
    }

    // Build ILIKE conditions for each significant word
    const conditions = words.map((_, i) => `t.title ILIKE $${i + 1}`).join(' OR ');
    const params = words.map((w) => `%${w}%`);

    const result = await query<{
      composite_score: string;
      outcome: string;
      dimension_notes: string | null;
      task_title: string;
    }>(
      `SELECT es.composite_score, es.outcome, es.dimension_notes, t.title AS task_title
       FROM eval_scores es
       JOIN tasks t ON t.id = es.task_id
       WHERE (${conditions})
       ORDER BY es.created_at DESC
       LIMIT 5`,
      params
    );

    if (result.rows.length < 3) {
      // Fewer than 3 previous evals — not enough to calibrate
      return { isFirstOfType: result.rows.length === 0, examples: [] };
    }

    return {
      isFirstOfType: false,
      examples: result.rows.slice(0, 3).map((r) => ({
        composite_score: parseFloat(r.composite_score),
        outcome: r.outcome,
        dimension_notes: r.dimension_notes ?? '',
        task_title: r.task_title,
      })),
    };
  } catch {
    return { isFirstOfType: true, examples: [] };
  }
}

function buildEvalPrompt(
  title: string,
  description: string | null,
  result: string,
  recipientContext: string,
  brandVoiceContext: string,
  calibration: CalibrationContext
): string {
  const parts: string[] = [
    `TASK BRIEF:`,
    `Title: ${title}`,
  ];
  if (description) parts.push(`Description: ${description}`);
  if (recipientContext) {
    parts.push(`\nRECIPIENT CONTEXT (from memory):\n${recipientContext}`);
  }
  if (brandVoiceContext) {
    parts.push(`\nBRAND VOICE / STYLE GUIDELINES:\n${brandVoiceContext}`);
  }

  if (calibration.isFirstOfType) {
    parts.push(`\nCALIBRATION NOTE: This is the first evaluation of this task type. Score independently without prior anchors.`);
  } else if (calibration.examples.length > 0) {
    const exStr = calibration.examples.map((ex, i) =>
      `  Example ${i + 1}: "${ex.task_title}" → composite ${ex.composite_score.toFixed(2)} (${ex.outcome})\n    Notes: ${ex.dimension_notes || 'none'}`
    ).join('\n');
    parts.push(
      `\nCALIBRATION CONTEXT (${calibration.examples.length} similar tasks previously scored):\n` +
      `Use these as anchors to maintain scoring consistency. Do not copy scores — use them to calibrate your rubric.\n${exStr}`
    );
  }

  parts.push(`\nOUTPUT TO EVALUATE:\n${result}`);
  parts.push(`\nProvide your evaluation JSON now:`);
  return parts.join('\n');
}

async function fetchRecipientContext(taskTitle: string): Promise<string> {
  try {
    const rows = await query<{ summary: string }>(
      `SELECT summary FROM unified_memory
       WHERE event_type = 'observation'
         AND summary ILIKE '%recipient%'
       ORDER BY importance DESC, created_at DESC
       LIMIT 3`
    );
    return rows.rows.map((r) => r.summary).join('\n');
  } catch {
    return '';
  }
}

async function fetchBrandVoiceContext(taskTitle: string): Promise<string> {
  try {
    const kbResults = await searchKnowledgeBase('brand voice style guidelines tone', 'eval', 3);
    if (kbResults.length > 0) {
      return kbResults.map((r) => r.content).join('\n\n');
    }
  } catch {
    // ignore
  }
  return '';
}

interface ParsedEval {
  scores: DimensionScores;
  dimension_notes: string;
  improvement_suggestions: string;
}

function parseEvalResponse(raw: string | null): ParsedEval {
  const fallback: ParsedEval = {
    scores: {
      technical_correctness: 3.0,
      completeness: 3.0,
      brand_voice: 3.0,
      recipient_personalization: 3.0,
      clarity: 3.0,
      contextual_appropriateness: 3.0,
    },
    dimension_notes: 'LLM evaluation unavailable — using neutral scores.',
    improvement_suggestions: 'None',
  };

  if (!raw) return fallback;

  // Strip markdown code fences if present
  const cleaned = raw.replace(/```(?:json)?\n?/g, '').replace(/```$/g, '').trim();

  // Extract JSON object
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return fallback;

  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;

    const clamp = (v: unknown): number => {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      if (isNaN(n)) return 3.0;
      return Math.min(5.0, Math.max(1.0, Math.round(n * 10) / 10));
    };

    return {
      scores: {
        technical_correctness:     clamp(obj['technical_correctness']),
        completeness:              clamp(obj['completeness']),
        brand_voice:               clamp(obj['brand_voice']),
        recipient_personalization: clamp(obj['recipient_personalization']),
        clarity:                   clamp(obj['clarity']),
        contextual_appropriateness: clamp(obj['contextual_appropriateness']),
      },
      dimension_notes:        typeof obj['dimension_notes'] === 'string' ? obj['dimension_notes'] : '',
      improvement_suggestions: typeof obj['improvement_suggestions'] === 'string' ? obj['improvement_suggestions'] : 'None',
    };
  } catch {
    return fallback;
  }
}

function computeComposite(scores: DimensionScores): number {
  let total = 0;
  for (const [dim, weight] of Object.entries(WEIGHTS) as [keyof DimensionScores, number][]) {
    total += scores[dim] * weight;
  }
  return Math.round(total * 100) / 100;
}

function determineOutcome(composite: number): 'approved' | 'needs_review' | 'needs_revision' {
  if (composite >= 3.5) return 'approved';
  if (composite >= 2.5) return 'needs_review';
  return 'needs_revision';
}

async function persistEval(params: {
  taskId: string;
  producerAgentSlug: string;
  scores: DimensionScores;
  composite: number;
  outcome: 'approved' | 'needs_review' | 'needs_revision';
  dimension_notes: string;
  improvement_suggestions: string;
  revisionNumber: number;
  previousEvalId?: string;
  eval_model: string;
}): Promise<string> {
  const [agentId, evalAgentId] = await Promise.all([
    resolveAgentId(params.producerAgentSlug),
    resolveAgentId('eval'),
  ]);

  const result = await query<{ id: string }>(
    `INSERT INTO eval_scores (
       task_id, agent_id, eval_agent_id,
       technical_correctness, completeness, brand_voice,
       recipient_personalization, clarity, contextual_appropriateness,
       composite_score, outcome,
       dimension_notes, improvement_suggestions,
       revision_number, previous_eval_id, eval_model
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6,
       $7, $8, $9,
       $10, $11,
       $12, $13,
       $14, $15, $16
     ) RETURNING id`,
    [
      params.taskId,
      agentId,
      evalAgentId,
      params.scores.technical_correctness,
      params.scores.completeness,
      params.scores.brand_voice,
      params.scores.recipient_personalization,
      params.scores.clarity,
      params.scores.contextual_appropriateness,
      params.composite,
      params.outcome,
      params.dimension_notes,
      params.improvement_suggestions,
      params.revisionNumber,
      params.previousEvalId ?? null,
      params.eval_model,
    ]
  );

  return result.rows[0]!.id;
}
