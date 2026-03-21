-- schema.sql
-- COMBINED SCHEMA REFERENCE (generated from migrations)
-- DO NOT HAND-EDIT THIS FILE
-- Run migrations via: bash scripts/migrate.sh
-- This file is for reference and documentation only

-- =============================================================================
-- 001_enable_pgvector.sql
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS pgvector;

COMMENT ON EXTENSION pgvector IS 'Vector similarity search (embeddings)';

-- =============================================================================
-- 002_create_agents.sql
-- =============================================================================
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('chief', 'sub-agent', 'system')),
  description TEXT,
  docker_image TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agents_slug ON agents (slug);
CREATE INDEX idx_agents_type ON agents (type);
CREATE INDEX idx_agents_active ON agents (is_active);

COMMENT ON TABLE agents IS 'Registry of all agents in the system (Alex, sub-agents, system)';
COMMENT ON COLUMN agents.slug IS 'Unique human-readable identifier (alex, email-writer, mailbox)';
COMMENT ON COLUMN agents.type IS 'Chief orchestrator, Sub-agent, or System background process';
COMMENT ON COLUMN agents.docker_image IS 'Docker image URI for the agent (null for always-on Alex)';

-- =============================================================================
-- 003_create_sessions.sql
-- =============================================================================
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

-- =============================================================================
-- 004_create_tasks.sql
-- =============================================================================
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

-- =============================================================================
-- 005_create_unified_memory.sql
-- =============================================================================
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

-- =============================================================================
-- 006_create_memory_consolidations.sql
-- =============================================================================
CREATE TABLE memory_consolidations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_memory_id UUID NOT NULL REFERENCES unified_memory(id) ON DELETE RESTRICT,
  time_range_start TIMESTAMPTZ NOT NULL,
  time_range_end TIMESTAMPTZ NOT NULL,
  memory_count INTEGER NOT NULL CHECK (memory_count > 0),
  agent_scope UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_consolidations_summary ON memory_consolidations (summary_memory_id);
CREATE INDEX idx_consolidations_time_range ON memory_consolidations (time_range_start, time_range_end);
CREATE INDEX idx_consolidations_agent ON memory_consolidations (agent_scope);

COMMENT ON TABLE memory_consolidations IS 'Rollup records: summarizes many old memories into one consolidation_summary record';
COMMENT ON COLUMN memory_consolidations.summary_memory_id IS 'FK to the unified_memory record with event_type=consolidation_summary';
COMMENT ON COLUMN memory_consolidations.agent_scope IS 'null=all agents, or specific agent_id for agent-specific consolidation';
COMMENT ON COLUMN memory_consolidations.memory_count IS 'How many original memories were synthesized into this summary';

-- =============================================================================
-- 007_add_consolidation_fk.sql
-- =============================================================================
ALTER TABLE unified_memory
ADD CONSTRAINT fk_unified_memory_consolidation
FOREIGN KEY (consolidation_id) REFERENCES memory_consolidations(id) ON DELETE SET NULL;

CREATE INDEX idx_unified_memory_consolidation ON unified_memory (consolidation_id);

COMMENT ON CONSTRAINT fk_unified_memory_consolidation ON unified_memory IS 'Backlink: if this memory was consolidated, which rollup record absorbed it?';

-- =============================================================================
-- 008_create_agent_memory.sql
-- =============================================================================
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

-- =============================================================================
-- 009_create_agent_tool_calls.sql
-- =============================================================================
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

-- =============================================================================
-- 010_create_knowledge_base.sql
-- =============================================================================
CREATE TABLE knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_index INTEGER DEFAULT 0,
  embedding vector(768),
  embedding_model TEXT DEFAULT 'nomic-embed-text',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_base_agent ON knowledge_base (agent_id);
CREATE INDEX idx_knowledge_base_source ON knowledge_base (source);
CREATE INDEX idx_knowledge_base_chunk ON knowledge_base (source, chunk_index);

COMMENT ON TABLE knowledge_base IS 'RAG knowledge: text chunks with embeddings, per-agent (agent_id null) or global';
COMMENT ON COLUMN knowledge_base.agent_id IS 'null=global knowledge readable by all agents, or specific agent_id for private knowledge';
COMMENT ON COLUMN knowledge_base.source IS 'Document source: file path, URL, doc name, etc.';
COMMENT ON COLUMN knowledge_base.chunk_index IS 'Position within the source document (for retrieval ordering)';
COMMENT ON COLUMN knowledge_base.metadata IS 'Source type, language, tags, etc.';

-- =============================================================================
-- 011_create_indexes.sql
-- =============================================================================
CREATE INDEX idx_unified_memory_embedding ON unified_memory USING ivfflat (embedding vector_cosine_ops) 
  WITH (lists = 100);

CREATE INDEX idx_agent_memory_embedding ON agent_memory USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX idx_knowledge_base_embedding ON knowledge_base USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

COMMENT ON INDEX idx_unified_memory_embedding IS 'IVFFlat (approx): semantic search in unified memories';
COMMENT ON INDEX idx_agent_memory_embedding IS 'IVFFlat (approx): semantic search in agent private memories';
COMMENT ON INDEX idx_knowledge_base_embedding IS 'IVFFlat (approx): semantic search in RAG knowledge base';

-- =============================================================================
-- END OF SCHEMA
-- =============================================================================
