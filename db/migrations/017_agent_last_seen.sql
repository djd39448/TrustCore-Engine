-- Migration 017: Add last_seen column to agents table
--
-- Replaces unified_memory heartbeat entries with a lightweight timestamp update.
-- Each agent writes one UPDATE per heartbeat interval instead of an INSERT into
-- unified_memory. Keeps the memory feed clean — only meaningful events remain.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

COMMENT ON COLUMN agents.last_seen IS
  'Timestamp of last liveness ping. Written by each agent once per heartbeat interval. '
  'Replaces unified_memory heartbeat entries. NULL means agent has never checked in.';

CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents (last_seen);
