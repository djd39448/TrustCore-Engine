-- Migration 019: Feedback/DPO pipeline tables
-- Creates the three tables required for the self-improvement training loop:
--   feedback        — one row per completed task; is the raw DPO training signal
--   training_jobs   — queued/running/completed training rounds
--   model_versions  — versioned model checkpoints with benchmark scores

-- ---------------------------------------------------------------------------
-- feedback
-- Captures the outcome of every evaluated task so the training factory can
-- build preference pairs (chosen/rejected) for DPO fine-tuning.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  task_id           uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  prompt            text NOT NULL,
  output            text NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('approved', 'approved_with_edits', 'rejected')),
  corrected_output  text,
  edit_distance     integer,
  reward_score      float,
  used_in_training  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_agent_id       ON feedback (agent_id);
CREATE INDEX IF NOT EXISTS idx_feedback_task_id        ON feedback (task_id);
CREATE INDEX IF NOT EXISTS idx_feedback_outcome        ON feedback (outcome);
CREATE INDEX IF NOT EXISTS idx_feedback_used_training  ON feedback (agent_id, used_in_training);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at     ON feedback (created_at DESC);

-- ---------------------------------------------------------------------------
-- training_jobs
-- Each row represents one scheduled or completed training round.
-- Alex creates rows here (status='queued'); the factory processes them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS training_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  trigger_type    text NOT NULL CHECK (trigger_type IN ('threshold', 'scheduled', 'emergency', 'manual')),
  trigger_value   integer,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'evaluating', 'promoted', 'discarded')),
  examples_used   integer,
  baseline_scores jsonb,
  new_scores      jsonb,
  promoted        boolean NOT NULL DEFAULT false,
  started_at      timestamptz,
  completed_at    timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_training_jobs_agent_id   ON training_jobs (agent_id);
CREATE INDEX IF NOT EXISTS idx_training_jobs_status     ON training_jobs (status);
CREATE INDEX IF NOT EXISTS idx_training_jobs_created_at ON training_jobs (created_at DESC);

-- ---------------------------------------------------------------------------
-- model_versions
-- One row per model checkpoint produced by a training job.
-- is_production=true marks the currently serving model for that agent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  version_number    integer NOT NULL,
  checkpoint_path   text,
  gguf_path         text,
  training_job_id   uuid REFERENCES training_jobs(id) ON DELETE SET NULL,
  benchmark_scores  jsonb,
  is_production     boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_versions_agent_id     ON model_versions (agent_id);
CREATE INDEX IF NOT EXISTS idx_model_versions_production   ON model_versions (agent_id, is_production);
CREATE INDEX IF NOT EXISTS idx_model_versions_training_job ON model_versions (training_job_id);
