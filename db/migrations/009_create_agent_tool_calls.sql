-- 009_create_agent_tool_calls.sql
-- Agent tool calls: high-volume operational log (what tool, input, output, result)

CREATE TABLE agent_tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_memory_id UUID REFERENCES agent_memory(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  tool_input JSONB NOT NULL DEFAULT '{}',
  tool_output JSONB,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'timeout')),
  error_message TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tool_calls_agent ON agent_tool_calls (agent_id, created_at DESC);
CREATE INDEX idx_tool_calls_task ON agent_tool_calls (task_id);
CREATE INDEX idx_tool_calls_tool_name ON agent_tool_calls (tool_name);
CREATE INDEX idx_tool_calls_status ON agent_tool_calls (status);
CREATE INDEX idx_tool_calls_session ON agent_tool_calls (session_id);

COMMENT ON TABLE agent_tool_calls IS 'High-volume raw operational log: every tool call by any agent';
COMMENT ON COLUMN agent_tool_calls.agent_memory_id IS 'Optional link: which agent_memory record describes this tool call?';
COMMENT ON COLUMN agent_tool_calls.status IS 'success, error, or timeout';
COMMENT ON COLUMN agent_tool_calls.duration_ms IS 'Tool execution time in milliseconds';
