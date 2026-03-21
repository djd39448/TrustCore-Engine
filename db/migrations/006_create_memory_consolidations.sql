-- 006_create_memory_consolidations.sql
-- Memory consolidations: rollup records for long-term memory compression

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
