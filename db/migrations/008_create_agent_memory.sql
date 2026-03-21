-- 008_create_agent_memory.sql
-- Agent memory: private journal per agent with fine-grained operational details

CREATE TABLE agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  unified_memory_id UUID REFERENCES unified_memory(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  memory_type TEXT NOT NULL CHECK (memory_type IN (
    'workflow_step', 'tool_use', 'feedback', 'observation', 'learned_preference'
  )),
  summary TEXT NOT NULL,
  content JSONB DEFAULT '{}',
  importance SMALLINT DEFAULT 3 CHECK (importance >= 1 AND importance <= 5),
  embedding vector(768),
  embedding_model TEXT DEFAULT 'nomic-embed-text',
  is_archived BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_memory_agent ON agent_memory (agent_id, created_at DESC);
CREATE INDEX idx_agent_memory_type ON agent_memory (agent_id, memory_type);
CREATE INDEX idx_agent_memory_task ON agent_memory (task_id);
CREATE INDEX idx_agent_memory_unified ON agent_memory (unified_memory_id);
CREATE INDEX idx_agent_memory_archived ON agent_memory (is_archived);

COMMENT ON TABLE agent_memory IS 'Private per-agent journal: workflow steps, tool details, feedback, learned preferences';
COMMENT ON COLUMN agent_memory.memory_type IS 'Classification: workflow_step, tool_use, feedback, observation, learned_preference';
COMMENT ON COLUMN agent_memory.unified_memory_id IS 'Optional backlink: if this detail corresponds to a unified event, which one?';
COMMENT ON COLUMN agent_memory.task_id IS 'Which task does this detail belong to (if any)?';
COMMENT ON COLUMN agent_memory.embedding IS 'Vector (768-dim) for semantic search within agent''s memory';
COMMENT ON COLUMN agent_memory.is_archived IS 'Soft delete: true means exclude from agent''s hot retrieval';
