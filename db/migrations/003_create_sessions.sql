-- 003_create_sessions.sql
-- Sessions table: bounded interaction windows (not memory boundaries)

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  initiated_by TEXT NOT NULL CHECK (initiated_by IN ('user', 'system', 'scheduled')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_started ON sessions (started_at DESC);
CREATE INDEX idx_sessions_ended ON sessions (ended_at DESC);
CREATE INDEX idx_sessions_initiated_by ON sessions (initiated_by);

COMMENT ON TABLE sessions IS 'Interaction sessions (not memory boundaries — memories outlive sessions)';
COMMENT ON COLUMN sessions.initiated_by IS 'Who started this session: user interaction, system task, or scheduled job';
COMMENT ON COLUMN sessions.metadata IS 'Session context: user_id, source, tags, etc.';
