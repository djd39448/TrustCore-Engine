-- 001_enable_pgvector.sql
-- Enable the pgvector extension for semantic search support

CREATE EXTENSION IF NOT EXISTS pgvector;

COMMENT ON EXTENSION pgvector IS 'Vector similarity search (embeddings)';
