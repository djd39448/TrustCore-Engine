-- 011_create_indexes.sql
-- Semantic search indexes using IVFFlat (approximate nearest neighbor)

-- Semantic search indexes for embedded tables
CREATE INDEX idx_unified_memory_embedding ON unified_memory USING ivfflat (embedding vector_cosine_ops) 
  WITH (lists = 100);

CREATE INDEX idx_agent_memory_embedding ON agent_memory USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX idx_knowledge_base_embedding ON knowledge_base USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

COMMENT ON INDEX idx_unified_memory_embedding IS 'IVFFlat (approx): semantic search in unified memories';
COMMENT ON INDEX idx_agent_memory_embedding IS 'IVFFlat (approx): semantic search in agent private memories';
COMMENT ON INDEX idx_knowledge_base_embedding IS 'IVFFlat (approx): semantic search in RAG knowledge base';
