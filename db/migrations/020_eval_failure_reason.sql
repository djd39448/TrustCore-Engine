-- Migration 020: Add failure_reason to eval_scores
-- Distinguishes whether a failed task was due to the executor agent
-- or Alex's orchestration/dispatch (e.g. missing required fields).
--
-- failure_reason = 'executor_failure'  — the sub-agent that did the work failed
-- failure_reason = 'caller_failure'    — Alex dispatched incorrectly (e.g. validation_error)
-- NULL                                 — not applicable / not yet classified

ALTER TABLE eval_scores
  ADD COLUMN IF NOT EXISTS failure_reason text
  CHECK (failure_reason IS NULL OR failure_reason IN ('executor_failure', 'caller_failure'));

CREATE INDEX IF NOT EXISTS idx_eval_scores_failure_reason
  ON eval_scores (failure_reason)
  WHERE failure_reason IS NOT NULL;
