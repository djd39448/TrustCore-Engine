-- 001_enable_pgvector.sql
-- Enable the pgvector extension for semantic search support

CREATE EXTENSION IF NOT EXISTS vector;

COMMENT ON EXTENSION vector IS 'Vector similarity search (embeddings)';
