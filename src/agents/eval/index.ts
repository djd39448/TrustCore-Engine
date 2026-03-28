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
  schema?: Record<string, unknown>; // task schema for type-specific rubric (e.g. email-outreach)
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

/**
 * Model used for evaluation. Runs on GPU 0 (ollama-gpu0) via the eval container.
 * Separate from Alex's qwen2.5:14b on GPU 1 — keeps eval load off Alex's GPU.
 */
const EVAL_MODEL = 'qwen2.5:7b';

/**
 * LLM queue priority for eval requests.
 * Priority 2 = sub-agent execution level (same as regular sub-agents).
 * Eval is not time-critical enough for priority 1 (alex routing).
 */
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

/**
 * Type-specific rubric text injected into the eval prompt when a task schema is present.
 * The rubric maps generic dimension names to what they mean for this task type,
 * so the model scores against the actual criteria rather than generic quality.
 */
const TASK_RUBRICS: Record<string, string> = {
  'email-outreach': `
TASK TYPE: email-outreach
Use this rubric — these are the criteria for each dimension:

- technical_correctness: Clarity of value proposition. Does the email make a compelling, specific case
  for why the recipient should respond? Score 5 if the value proposition is crystal-clear and specific
  to the recipient's context. Score 1 if it's generic filler with no real reason to reply.

- completeness: All required email elements present — subject line, personalised greeting, value
  proposition body, specific call-to-action, professional sign-off. Score 5 if all elements are strong
  and complete. Score 1 if key elements (especially CTA or subject) are missing.

- brand_voice: Tone appropriateness for the relationship. Cold outreach = professional, respectful,
  not overly familiar. Warm intro = warmer but still focused. Score 5 if tone perfectly matches the
  relationship context. Score 1 if tone is wrong (e.g. overly casual for a first contact).

- recipient_personalization: Personalization quality. Does the email reference the recipient's specific
  name, role, company, and any known context? Score 5 if highly personalised to the individual.
  Score 1 if completely generic — could have been sent to anyone.

- clarity: Readability and conciseness. Cold outreach should be under 200 words. Is it easy to scan?
  Free of jargon? Respects the recipient's time? Score 5 if concise, clear, and easily read in under
  30 seconds. Score 1 if verbose, repetitive, or hard to follow.

- contextual_appropriateness: Call-to-action quality. Is the CTA specific, low-friction, and aligned
  with the goal? A good cold outreach CTA asks for a short call or meeting, not a commitment.
  Score 5 if the CTA is perfectly calibrated for the goal and relationship. Score 1 if missing,
  too aggressive, or misaligned with the email's goal.`,
};

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
    schema,
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
    calibrationContext,
    schema
  );

  // --- Call LLM ---
  const rawResponse = await chat(
    [
      { role: 'system', content: EVAL_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
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
    result,
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

/**
 * Load previous eval results for tasks similar to this one.
 * Extracts significant words from the title (>3 chars, up to 5) and queries
 * eval_scores for tasks with matching titles using ILIKE.
 *
 * Returns up to 3 examples when ≥ 3 prior evals exist — the prompt uses these
 * as scoring anchors to maintain consistency across evaluations of similar tasks.
 * Returns isFirstOfType=true when no prior data exists, which triggers a note
 * in the prompt telling the model to score without calibration anchors.
 *
 * Why calibration? Without it, the model's absolute scores drift across sessions.
 * Anchoring to prior scores keeps the composite scale stable enough to be useful
 * as a DPO training signal.
 */
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
  calibration: CalibrationContext,
  schema?: Record<string, unknown>
): string {
  // Inject type-specific rubric if we recognise the task type
  const taskType = (schema?.['type'] as string | undefined)
    ?? (schema?.['eval'] as Record<string, unknown> | undefined)?.['type'] as string | undefined;
  const rubric = taskType ? TASK_RUBRICS[taskType] : undefined;

  const parts: string[] = [
    `TASK BRIEF:`,
    `Title: ${title}`,
  ];
  if (description && !schema) parts.push(`Description: ${description}`);

  // If schema present, surface structured fields clearly
  if (schema) {
    const r = schema['recipient'] as Record<string, string> | undefined;
    if (r) {
      const recipientLine = [r['name'], r['role'], r['company']].filter(Boolean).join(', ');
      if (recipientLine) parts.push(`Recipient: ${recipientLine}`);
      if (r['relationship']) parts.push(`Relationship: ${r['relationship']}`);
      if (r['context']) parts.push(`Recipient context: ${r['context']}`);
    }
    if (schema['goal']) parts.push(`Goal: ${schema['goal']}`);
    if (schema['tone']) parts.push(`Required tone: ${schema['tone']}`);
    if (schema['length']) parts.push(`Target length: ${schema['length']}`);
    const constraints = schema['constraints'] as string[] | undefined;
    if (constraints?.length) parts.push(`Constraints: ${constraints.join('; ')}`);
  }

  if (rubric) {
    parts.push(rubric);
  }
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

/**
 * Pull stored observations about the task's recipient from unified_memory.
 * Injected into the eval prompt to let the model score recipient_personalization
 * against what is actually known about that person, not generic criteria.
 * Returns empty string if no recipient observations found (graceful degradation).
 */
async function fetchRecipientContext(_taskTitle: string): Promise<string> {
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

/**
 * Search the knowledge base for brand voice and style guidelines.
 * Injected into the eval prompt so the model can score brand_voice against
 * the actual documented style rather than guessing what "on-brand" means.
 * Returns empty string if no brand voice KB entries exist.
 */
async function fetchBrandVoiceContext(_taskTitle: string): Promise<string> {
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

/**
 * Compute the weighted composite score from individual dimension scores.
 * Weights are defined in WEIGHTS (completeness and brand_voice each 20%,
 * technical_correctness and clarity each 15%, contextual_appropriateness 10%).
 * Result is rounded to 2 decimal places.
 */
function computeComposite(scores: DimensionScores): number {
  let total = 0;
  for (const [dim, weight] of Object.entries(WEIGHTS) as [keyof DimensionScores, number][]) {
    total += scores[dim] * weight;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Map a composite score to a human-readable outcome label.
 *   ≥ 3.5  → approved     (good enough to deliver without human review)
 *   ≥ 2.5  → needs_review  (borderline — surface to human for approval)
 *   < 2.5  → needs_revision (clearly below bar — agent should revise)
 *
 * These thresholds can be overridden per-skill in the skill schema's eval.threshold.
 * The outcome is stored in eval_scores and drives Alex's post-eval routing logic.
 */
function determineOutcome(composite: number): 'approved' | 'needs_review' | 'needs_revision' {
  if (composite >= 3.5) return 'approved';
  if (composite >= 2.5) return 'needs_review';
  return 'needs_revision';
}

/**
 * Classify the failure reason for a task result.
 *
 * 'caller_failure'   — Alex dispatched incorrectly; the result contains a
 *                       validation_error or missing_fields indicator.
 * 'executor_failure' — the sub-agent that did the work failed.
 * null               — not a failure (outcome is approved or needs_review).
 */
function classifyFailureReason(
  outcome: 'approved' | 'needs_review' | 'needs_revision',
  result: unknown,
): 'caller_failure' | 'executor_failure' | null {
  if (outcome === 'approved' || outcome === 'needs_review') return null;

  // Check if the result text indicates a validation / dispatch error
  const resultText = typeof result === 'string'
    ? result.toLowerCase()
    : JSON.stringify(result).toLowerCase();

  if (
    resultText.includes('validation_error') ||
    resultText.includes('missing_fields') ||
    resultText.includes('missing fields') ||
    resultText.includes('invalid schema')
  ) {
    return 'caller_failure';
  }

  return 'executor_failure';
}

/**
 * Write the completed eval result to eval_scores in the DB.
 * Records all 6 dimension scores, the composite, outcome, dimension notes,
 * improvement suggestions, the model used, and the revision chain.
 *
 * The revision chain (revision_number + previous_eval_id) lets the DPO
 * training pipeline compare initial output vs. revised output for the same task,
 * which is the core signal for preference learning.
 *
 * Returns the new eval record's UUID so callers can reference it in memory writes.
 */
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
  result?: unknown;
}): Promise<string> {
  const [agentId, evalAgentId] = await Promise.all([
    resolveAgentId(params.producerAgentSlug),
    resolveAgentId('eval'),
  ]);

  const failureReason = classifyFailureReason(params.outcome, params.result);

  const result = await query<{ id: string }>(
    `INSERT INTO eval_scores (
       task_id, agent_id, eval_agent_id,
       technical_correctness, completeness, brand_voice,
       recipient_personalization, clarity, contextual_appropriateness,
       composite_score, outcome,
       dimension_notes, improvement_suggestions,
       revision_number, previous_eval_id, eval_model, failure_reason
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6,
       $7, $8, $9,
       $10, $11,
       $12, $13,
       $14, $15, $16, $17
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
      failureReason,
    ]
  );

  return result.rows[0]!.id;
}
