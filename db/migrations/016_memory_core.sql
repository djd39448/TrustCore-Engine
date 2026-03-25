-- 016_memory_core.sql
-- Create MemoryCore tables: memory_chunks, memory_summaries, memory_archive
-- Source: TrustCore-MemoryCore v0.1.0 (TrustCore-MemoryCore/db/schema.sql)
-- All three tables are append-only — no content columns are ever UPDATE'd or DELETE'd.
-- The only permitted post-INSERT mutation: memory_chunks.archived / archived_at (set by archive()).

-- pgcrypto: gen_random_uuid() — built-in in PG13+, this guard is safe no-op if already present
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- vector: already enabled in 001_enable_pgvector.sql; IF NOT EXISTS makes this idempotent
CREATE EXTENSION IF NOT EXISTS "vector";

-- =============================================================================
-- TABLE: memory_chunks
-- =============================================================================
-- Full, immutable conversation records. One row per stored chunk.
--
-- Every chunk that enters MemoryCore lives here first. After the configurable
-- archive threshold (min 7 days), it is copied to memory_archive and marked
-- archived=TRUE here. The original row is never deleted — summary signpost
-- hashes point back to these rows and those references must remain valid.
--
-- session_id is required. Sessions are the isolation boundary between
-- different conversation contexts. Summaries must never mix sessions unless
-- a cross-session merge is explicitly requested.
--
-- embedding is nullable — MemoryCore does not generate embeddings. If the
-- caller provides a 768-dim nomic-embed-text vector, it is stored here and
-- becomes available for semantic_search(). If not provided, the chunk is
-- invisible to vector search but still fully functional for all other ops.
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_chunks (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- SHA-256(agent_id + ":" + content_text + ":" + iso_timestamp)
    -- Tamper-proof identity. Any mutation of content changes this hash.
    -- Also the stable external reference: callers store this to use in summarize().
    signpost_id     CHAR(64)        NOT NULL UNIQUE,

    -- Which agent owns this memory.
    agent_id        UUID            NOT NULL,

    -- Required. Sessions isolate conversation contexts from each other.
    -- Chunks from different sessions must not bleed into the same summary chain
    -- without an explicit cross-session merge (sessionId omitted in load()).
    session_id      UUID            NOT NULL,

    -- Full serialized ASBCP v0.1.0 memory message. Includes intent, enrichment,
    -- routing, and the LLM-assigned classification embedded in enrichment.
    asbcp_message   JSONB           NOT NULL,

    -- Raw conversation text. Used by summarize() as LLM input and by recall()
    -- for keyword search. Stored in full — never truncated.
    content_text    TEXT            NOT NULL,

    -- LLM-assigned classification. Stored as a separate JSONB column (not inside
    -- metadata) so it can be indexed with GIN and filtered efficiently in recall().
    -- Fields: category, entities[], importance, keywords[], emotion_signal, tags[]
    classification  JSONB           NOT NULL,

    -- Optional 768-dimensional embedding vector (nomic-embed-text).
    -- Caller's responsibility to generate. NULL = not indexed for semantic search.
    embedding       vector(768),

    -- Caller-provided passthrough metadata. Not interpreted by MemoryCore.
    metadata        JSONB           NOT NULL DEFAULT '{}',

    -- Soft-archive flag. TRUE = this record has been copied to memory_archive.
    -- The row remains here with archived=TRUE so signpost references stay valid.
    archived        BOOLEAN         NOT NULL DEFAULT FALSE,
    archived_at     TIMESTAMPTZ,

    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- B-tree indexes for common filter patterns
CREATE INDEX IF NOT EXISTS idx_memory_chunks_agent_id     ON memory_chunks (agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_session_id   ON memory_chunks (session_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_signpost_id  ON memory_chunks (signpost_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_archived     ON memory_chunks (archived);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_created_at   ON memory_chunks (created_at);
-- Composite: most common query pattern in archive() — agent + age + not-yet-archived
CREATE INDEX IF NOT EXISTS idx_memory_chunks_archive_scan ON memory_chunks (agent_id, created_at) WHERE archived = FALSE;

-- IVFFlat index for approximate nearest-neighbor cosine similarity search.
-- lists=100 is a reasonable default for up to ~1M rows. Tune upward for larger datasets.
-- Requires: SET ivfflat.probes = N for recall/precision tradeoff at query time.
CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding    ON memory_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);


-- =============================================================================
-- TABLE: memory_summaries
-- =============================================================================
-- Append-only summary chain. Each row summarizes N source chunks and links
-- back to the previous summary, forming a singly-linked list ordered by time.
--
-- Chain structure (most recent at head):
--   summary_K -> summary_{K-1} -> ... -> summary_1 -> NULL
--
-- previous_summary_id + previous_hash are both stored for:
--   - UUID: enables JOIN-based chain traversal
--   - Hash: enables tamper detection without a JOIN
--
-- The summary chain is intentionally flat: every summary covers raw chunks only.
-- There is no summary-of-summaries. depth has been removed by design.
--
-- session_id scopes the chain. The load() function returns summaries from
-- a specific session (if sessionId is provided) or across all sessions
-- (if omitted — caller explicitly accepts cross-session context merge).
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_summaries (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- SHA-256(agent_id + ":" + summary_text + ":" + sorted_source_hashes + ":" + timestamp)
    -- Source hashes are sorted before hashing so [A,B] and [B,A] yield the same signpost.
    signpost_id             CHAR(64)    NOT NULL UNIQUE,

    agent_id                UUID        NOT NULL,
    session_id              UUID        NOT NULL,

    -- The LLM-generated summary text. Dense, context-ready, 2-5 sentences.
    summary_text            TEXT        NOT NULL,

    -- Array of memory_chunks.signpost_id values that this summary covers.
    -- These are permanent back-references — even if chunks are archived,
    -- these hashes remain resolvable via memory_archive.
    source_chunk_hashes     TEXT[]      NOT NULL,

    -- Chain linkage — points to the previous summary appended for this agent+session.
    -- NULL on the first summary in a chain.
    previous_summary_id     UUID        REFERENCES memory_summaries(id),
    previous_hash           CHAR(64),   -- signpost_id of previous summary (denormalized for fast reads)

    -- Caller-provided passthrough metadata for this summary.
    metadata                JSONB       NOT NULL DEFAULT '{}',

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_summaries_agent_id    ON memory_summaries (agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_summaries_session_id  ON memory_summaries (session_id);
CREATE INDEX IF NOT EXISTS idx_memory_summaries_signpost_id ON memory_summaries (signpost_id);
-- Primary access pattern for load(): agent + session, ordered by time
CREATE INDEX IF NOT EXISTS idx_memory_summaries_chain       ON memory_summaries (agent_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_summaries_prev        ON memory_summaries (previous_summary_id);


-- =============================================================================
-- TABLE: memory_archive
-- =============================================================================
-- Cold storage. Rows are copied here from memory_chunks by archive().
-- Schema mirrors memory_chunks with two differences:
--   1. archived / archived_at are removed (everything here is archived)
--   2. original_created_at replaces created_at (preserves the original timestamp)
--
-- This table is the permanent record. Nothing is ever deleted from it.
-- recall() searches this table. semantic_search() can optionally include it.
--
-- Why copy instead of move?
-- memory_chunks rows are kept (with archived=TRUE) because other tables hold
-- foreign-key-equivalent references via signpost hashes. Copies ensure cold
-- storage has a complete, self-contained record without requiring joins back
-- to memory_chunks for full data retrieval.
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_archive (
    id                  UUID        PRIMARY KEY,    -- same UUID as source memory_chunks row
    signpost_id         CHAR(64)    NOT NULL UNIQUE,
    agent_id            UUID        NOT NULL,
    session_id          UUID        NOT NULL,
    asbcp_message       JSONB       NOT NULL,
    content_text        TEXT        NOT NULL,
    classification      JSONB       NOT NULL,
    embedding           vector(768),
    metadata            JSONB       NOT NULL DEFAULT '{}',

    -- Preserved from memory_chunks.created_at — when the chunk was originally stored.
    original_created_at TIMESTAMPTZ NOT NULL,

    -- When archive() moved this record to cold storage.
    archived_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_archive_agent_id        ON memory_archive (agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_archive_session_id      ON memory_archive (session_id);
CREATE INDEX IF NOT EXISTS idx_memory_archive_signpost_id     ON memory_archive (signpost_id);
CREATE INDEX IF NOT EXISTS idx_memory_archive_created_at      ON memory_archive (original_created_at);
-- GIN index on classification JSONB — enables efficient recall() filtering on
-- category, tags, keywords without full table scan of the JSONB blob.
CREATE INDEX IF NOT EXISTS idx_memory_archive_classification  ON memory_archive USING gin (classification);
-- IVFFlat index for optional semantic search over cold storage.
CREATE INDEX IF NOT EXISTS idx_memory_archive_embedding       ON memory_archive USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
