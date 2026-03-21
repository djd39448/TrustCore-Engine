-- 005_create_unified_memory.sql
-- Unified memory: shared consciousness, readable by all agents, written by each about their actions

CREATE TABLE unified_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  author_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'task_started', 'task_completed', 'task_failed', 
    'agent_called', 'user_interaction', 'observation', 
    'consolidation_summary'
  )),
  summary TEXT NOT NULL,
  content JSONB DEFAULT '{}',
  importance SMALLINT DEFAULT 3 CHECK (importance >= 1 AND importance <= 5),
  embedding vector(768),
  embedding_model TEXT DEFAULT 'nomic-embed-text',
  tags TEXT[] DEFAULT '{}',
  is_archived BOOLEAN DEFAULT false,
  is_consolidated BOOLEAN DEFAULT false,
  consolidation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- consolidation_id FK added in migration 007 (circular dependency resolved)

CREATE INDEX idx_unified_memory_author ON unified_memory (author_agent_id, created_at DESC);
CREATE INDEX idx_unified_memory_event_type ON unified_memory (event_type, created_at DESC);
CREATE INDEX idx_unified_memory_session ON unified_memory (session_id, created_at DESC);
CREATE INDEX idx_unified_memory_tags ON unified_memory USING GIN (tags);
CREATE INDEX idx_unified_memory_archived ON unified_memory (is_archived, created_at DESC);
CREATE INDEX idx_unified_memory_consolidated ON unified_memory (is_consolidated);

COMMENT ON TABLE unified_memory IS 'Shared consciousness: events readable by all agents, authored by each about their own actions';
COMMENT ON COLUMN unified_memory.event_type IS 'Classification for filtering and retrieval';
COMMENT ON COLUMN unified_memory.importance IS '1=low to 5=critical; boosts retrieval ranking';
COMMENT ON COLUMN unified_memory.embedding IS 'Vector (768-dim) for semantic search via pgvector';
COMMENT ON COLUMN unified_memory.embedding_model IS 'Which model generated this embedding (for future migration)';
COMMENT ON COLUMN unified_memory.is_archived IS 'Soft delete: true means exclude from hot retrieval';
COMMENT ON COLUMN unified_memory.is_consolidated IS 'true means this was rolled into a consolidation_summary';
COMMENT ON COLUMN unified_memory.consolidation_id IS 'FK to the consolidation_summary that absorbed this memory';
