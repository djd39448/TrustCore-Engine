-- Migration 013: Eval tables for multi-dimensional output scoring + DPO training signal

CREATE TABLE IF NOT EXISTS eval_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),           -- agent that produced the output
  eval_agent_id UUID NOT NULL REFERENCES agents(id),      -- agent that evaluated (eval agent)

  -- 6 weighted dimensions (1.0–5.0 scale)
  technical_correctness NUMERIC(3,1) NOT NULL CHECK (technical_correctness BETWEEN 1 AND 5),
  completeness          NUMERIC(3,1) NOT NULL CHECK (completeness          BETWEEN 1 AND 5),
  brand_voice           NUMERIC(3,1) NOT NULL CHECK (brand_voice           BETWEEN 1 AND 5),
  recipient_personalization NUMERIC(3,1) NOT NULL CHECK (recipient_personalization BETWEEN 1 AND 5),
  clarity               NUMERIC(3,1) NOT NULL CHECK (clarity               BETWEEN 1 AND 5),
  contextual_appropriateness NUMERIC(3,1) NOT NULL CHECK (contextual_appropriateness BETWEEN 1 AND 5),

  -- weighted composite: technical_correctness*0.15 + completeness*0.20 + brand_voice*0.20
  --                     + recipient_personalization*0.20 + clarity*0.15 + contextual_appropriateness*0.10
  composite_score NUMERIC(4,2) NOT NULL,

  -- outcome thresholds: >=3.5 approved, 2.5-3.49 needs_review, <2.5 needs_revision
  outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('approved', 'needs_review', 'needs_revision')),

  -- per-dimension narrative and suggestions
  dimension_notes        TEXT,
  improvement_suggestions TEXT,

  -- revision tracking (self-referential chain)
  revision_number   INT NOT NULL DEFAULT 0,
  previous_eval_id  UUID REFERENCES eval_scores(id),

  -- which model did the eval
  eval_model VARCHAR(100),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_scores_task_id      ON eval_scores(task_id);
CREATE INDEX IF NOT EXISTS idx_eval_scores_agent_id     ON eval_scores(agent_id);
CREATE INDEX IF NOT EXISTS idx_eval_scores_outcome      ON eval_scores(outcome);
CREATE INDEX IF NOT EXISTS idx_eval_scores_created_at   ON eval_scores(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_scores_composite    ON eval_scores(composite_score DESC);
