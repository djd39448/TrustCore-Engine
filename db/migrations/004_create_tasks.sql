-- 004_create_tasks.sql
-- Tasks table: first-class task tree with parent-child hierarchy

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_by_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  assigned_to_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  result JSONB DEFAULT '{}',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_session ON tasks (session_id);
CREATE INDEX idx_tasks_parent ON tasks (parent_task_id);
CREATE INDEX idx_tasks_created_by ON tasks (created_by_agent_id);
CREATE INDEX idx_tasks_assigned_to ON tasks (assigned_to_agent_id, status);
CREATE INDEX idx_tasks_status ON tasks (status);
CREATE INDEX idx_tasks_created ON tasks (created_at DESC);

COMMENT ON TABLE tasks IS 'First-class tasks: orchestration spine for memories and execution';
COMMENT ON COLUMN tasks.parent_task_id IS 'Subtask hierarchy: decompose large tasks into smaller work units';
COMMENT ON COLUMN tasks.status IS 'pending, in_progress, completed, failed, cancelled';
COMMENT ON COLUMN tasks.result IS 'Task-specific results/output';
