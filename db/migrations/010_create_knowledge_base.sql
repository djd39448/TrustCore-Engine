-- 010_create_knowledge_base.sql
-- Knowledge base: RAG chunks per-agent or global

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
