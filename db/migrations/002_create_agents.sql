-- 002_create_agents.sql
-- Agents table: registry of all agents (Alex, sub-agents, system)

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
