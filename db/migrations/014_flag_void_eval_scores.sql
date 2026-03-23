-- 014_flag_void_eval_scores.sql
-- Add calibration_void flag to eval_scores.
--
-- All eval scores produced before the fix at commit cb779cd (2026-03-23) used
-- a broken evaluation path: EVAL_SYSTEM (the JSON schema + scoring instructions)
-- was defined but never passed to the LLM. The model received only task context
-- with no format instruction, responded in prose, JSON parsing failed, and
-- parseEvalResponse() returned the all-3.0 fallback every time.
--
-- The fix: pass { role: 'system', content: EVAL_SYSTEM } as the first message.
-- Real scores now vary (good output ~4.4, bad output ~1.6).
--
-- calibration_void = true marks these rows as unsuitable for DPO training
-- or scoring calibration. New evals (post-fix) will have calibration_void = false.

ALTER TABLE eval_scores
  ADD COLUMN IF NOT EXISTS calibration_void BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN eval_scores.calibration_void IS
  'true = this score was produced by a broken eval path and must not be used '
  'as a DPO training signal or calibration anchor. Set on all pre-fix rows '
  'identified by composite_score = 3.0 (the all-dimensions fallback value).';

-- Mark all existing rows as void. Every row in eval_scores at migration time
-- was produced by the broken path — the tell is composite_score exactly 3.0
-- (all 6 dimensions return 3.0 when JSON parsing falls back to the default).
-- Using composite_score = 3.0 rather than a date cutoff is more precise:
-- it flags broken scores regardless of when they were written.
UPDATE eval_scores
SET calibration_void = true
WHERE composite_score = 3.00
  AND calibration_void = false;

