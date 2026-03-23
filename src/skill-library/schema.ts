/**
 * Phase 9a — Skill Library JSON Schema Standard
 *
 * TypeScript interfaces, validator, and loader for the TrustCore skill schema format.
 * Every skill schema file must conform to SkillSchema and pass validateSkillSchema().
 *
 * File placement convention:
 *   src/skill-library/skills/<agent-slug>/<skill-type>.schema.json
 *
 * Example:
 *   src/skill-library/skills/email-writer/cold-outreach.schema.json
 */

// ---------------------------------------------------------------------------
// Enum types
// ---------------------------------------------------------------------------

export type DeliveryMethod = 'smtp' | 'queue' | 'draft';

export type EvalDimension =
  | 'personalization'
  | 'clarity'
  | 'brand_voice'
  | 'technical_correctness'
  | 'completeness'
  | 'recipient_personalization'
  | 'contextual_appropriateness';

export type ConstraintFormat = 'plain text' | 'markdown' | 'html';

export type OnBelowThreshold =
  | 'revise_once_then_escalate'
  | 'escalate'
  | 'auto_revise';

export type OnNovelType =
  | 'escalate_to_alex'
  | 'attempt_best_match'
  | 'reject';

// ---------------------------------------------------------------------------
// Sub-specs
// ---------------------------------------------------------------------------

/**
 * Who the skill output is addressed to.
 * memory_search: true instructs the agent to query both unified_memory and
 * agent_memory for everything stored about this recipient before generating.
 */
export interface RecipientSpec {
  name: string;
  role?: string;
  company?: string;
  memory_search: boolean;
}

/**
 * Subject/headline guidance for the output.
 */
export interface SubjectSpec {
  theme: string;
  keywords?: string[];
  tone: string;
}

/**
 * Body/content generation guidance.
 * use_soul: inject the agent's Soul.md voice and tone document.
 * use_recipient_memory: personalize from stored memories about the recipient.
 * use_user_preferences: apply the user's stored communication preferences.
 */
export interface BodySpec {
  pain_points?: string[];
  use_soul: boolean;
  use_recipient_memory: boolean;
  use_user_preferences: boolean;
  call_to_action: string;
}

/**
 * Hard output constraints enforced before delivery.
 */
export interface ConstraintSpec {
  max_length: string;         // format: "N words" | "N characters" | "N lines"
  format: ConstraintFormat;
}

/**
 * Delivery configuration.
 * requires_approval: surface in Mission Control review queue before sending.
 * approval_timeout: how long to wait for human approval before applying fallback.
 * approval_channel: where Alex surfaces the review request ("chat", "email", etc.)
 * fallback: behavior when approval_timeout elapses without a decision.
 */
export interface DeliverySpec {
  method: DeliveryMethod;
  requires_approval: boolean;
  approval_timeout?: string;
  approval_channel?: string;
  fallback?: string;
}

/**
 * Eval configuration embedded in the skill schema.
 * The eval agent uses these to score output against skill-specific criteria
 * rather than generic dimensions, making the training signal task-specific.
 *
 * threshold: composite score (1.0–5.0) below which on_below_threshold applies.
 * on_below_threshold: what to do when the output scores below threshold.
 * on_novel_type: what to do when the agent receives a task type with no match.
 */
export interface EvalSpec {
  dimensions: EvalDimension[];
  threshold: number;
  on_below_threshold: OnBelowThreshold;
  on_novel_type: OnNovelType;
}

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

/**
 * SkillSchema — the canonical contract for a skill in the TrustCore skill library.
 *
 * Required fields: type, version, description, agent, constraints, delivery, eval.
 * Optional sections: recipient, subject, body (present only when the skill needs them).
 *
 * type must be kebab-case (e.g. "cold-outreach", "daily-snapshot").
 * version must be semver (e.g. "1.0.0").
 * agent must match a slug in the agents table.
 */
export interface SkillSchema {
  type: string;
  version: string;
  description: string;
  agent: string;
  recipient?: RecipientSpec;
  subject?: SubjectSpec;
  body?: BodySpec;
  constraints: ConstraintSpec;
  delivery: DeliverySpec;
  eval: EvalSpec;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_EVAL_DIMENSIONS = new Set<EvalDimension>([
  'personalization',
  'clarity',
  'brand_voice',
  'technical_correctness',
  'completeness',
  'recipient_personalization',
  'contextual_appropriateness',
]);

const VALID_FORMATS = new Set<ConstraintFormat>(['plain text', 'markdown', 'html']);
const VALID_METHODS = new Set<DeliveryMethod>(['smtp', 'queue', 'draft']);
const VALID_ON_BELOW = new Set<OnBelowThreshold>([
  'revise_once_then_escalate',
  'escalate',
  'auto_revise',
]);
const VALID_ON_NOVEL = new Set<OnNovelType>([
  'escalate_to_alex',
  'attempt_best_match',
  'reject',
]);

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const MAX_LENGTH_RE = /^\d+ (words|characters|lines)$/;

/**
 * Validate a raw object against the SkillSchema spec.
 * Returns all errors found (not just the first), so schema authors get
 * complete feedback in one pass.
 */
export function validateSkillSchema(schema: unknown): ValidationResult {
  const errors: string[] = [];

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { valid: false, errors: ['Schema must be a non-null object'] };
  }

  const s = schema as Record<string, unknown>;

  // --- Top-level required strings ---
  if (typeof s['type'] !== 'string' || !KEBAB_CASE_RE.test(s['type'])) {
    errors.push('type: required, must be kebab-case (e.g. "cold-outreach")');
  }
  if (typeof s['version'] !== 'string' || !SEMVER_RE.test(s['version'])) {
    errors.push('version: required, must be semver (e.g. "1.0.0")');
  }
  if (typeof s['description'] !== 'string' || s['description'].trim().length === 0) {
    errors.push('description: required non-empty string');
  }
  if (typeof s['agent'] !== 'string' || s['agent'].trim().length === 0) {
    errors.push('agent: required non-empty string (must match an agent slug)');
  }

  // --- constraints (required) ---
  const c = s['constraints'];
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    errors.push('constraints: required object');
  } else {
    const cs = c as Record<string, unknown>;
    if (typeof cs['max_length'] !== 'string' || !MAX_LENGTH_RE.test(cs['max_length'])) {
      errors.push('constraints.max_length: must match "N words|characters|lines" (e.g. "300 words")');
    }
    if (!VALID_FORMATS.has(cs['format'] as ConstraintFormat)) {
      errors.push(`constraints.format: must be one of ${[...VALID_FORMATS].map((f) => `"${f}"`).join(', ')}`);
    }
  }

  // --- delivery (required) ---
  const d = s['delivery'];
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    errors.push('delivery: required object');
  } else {
    const ds = d as Record<string, unknown>;
    if (!VALID_METHODS.has(ds['method'] as DeliveryMethod)) {
      errors.push(`delivery.method: must be one of ${[...VALID_METHODS].map((m) => `"${m}"`).join(', ')}`);
    }
    if (typeof ds['requires_approval'] !== 'boolean') {
      errors.push('delivery.requires_approval: required boolean');
    }
    if (ds['approval_timeout'] !== undefined && typeof ds['approval_timeout'] !== 'string') {
      errors.push('delivery.approval_timeout: must be a string if provided (e.g. "24h")');
    }
  }

  // --- eval (required) ---
  const e = s['eval'];
  if (!e || typeof e !== 'object' || Array.isArray(e)) {
    errors.push('eval: required object');
  } else {
    const es = e as Record<string, unknown>;

    if (!Array.isArray(es['dimensions']) || es['dimensions'].length === 0) {
      errors.push('eval.dimensions: required non-empty array');
    } else {
      for (const dim of es['dimensions']) {
        if (!VALID_EVAL_DIMENSIONS.has(dim as EvalDimension)) {
          errors.push(
            `eval.dimensions: unknown dimension "${String(dim)}" — valid: ${[...VALID_EVAL_DIMENSIONS].join(', ')}`
          );
        }
      }
    }

    const thr = es['threshold'];
    if (typeof thr !== 'number' || isNaN(thr) || thr < 1.0 || thr > 5.0) {
      errors.push('eval.threshold: required number between 1.0 and 5.0');
    }

    if (!VALID_ON_BELOW.has(es['on_below_threshold'] as OnBelowThreshold)) {
      errors.push(
        `eval.on_below_threshold: must be one of ${[...VALID_ON_BELOW].map((v) => `"${v}"`).join(', ')}`
      );
    }

    if (!VALID_ON_NOVEL.has(es['on_novel_type'] as OnNovelType)) {
      errors.push(
        `eval.on_novel_type: must be one of ${[...VALID_ON_NOVEL].map((v) => `"${v}"`).join(', ')}`
      );
    }
  }

  // --- optional recipient ---
  const r = s['recipient'];
  if (r !== undefined) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push('recipient: must be an object if provided');
    } else {
      const rs = r as Record<string, unknown>;
      if (typeof rs['name'] !== 'string') {
        errors.push('recipient.name: required string');
      }
      if (typeof rs['memory_search'] !== 'boolean') {
        errors.push('recipient.memory_search: required boolean');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Load and validate a skill schema from a parsed JSON object.
 * Throws a descriptive error listing all validation failures if invalid.
 */
export function loadSkillSchema(raw: unknown): SkillSchema {
  const { valid, errors } = validateSkillSchema(raw);
  if (!valid) {
    throw new Error(
      `Invalid skill schema:\n${errors.map((e) => `  • ${e}`).join('\n')}`
    );
  }
  return raw as SkillSchema;
}
