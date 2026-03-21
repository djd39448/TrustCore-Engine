-- seed.sql
-- Initial data: seed the system with Alex (chief) and System (background process)

-- Insert the System agent (background processes)
INSERT INTO agents (slug, display_name, type, description, is_active)
VALUES (
  'system',
  'System',
  'system',
  'Background system processes: consolidation, cleanup, heartbeats',
  true
)
ON CONFLICT (slug) DO NOTHING;

-- Insert the Alex agent (chief of staff, always-on)
INSERT INTO agents (slug, display_name, type, description, docker_image, is_active)
VALUES (
  'alex',
  'Alex',
  'chief',
  'Chief of staff agent: orchestrates sub-agents, maintains shared consciousness, always-on',
  NULL,
  true
)
ON CONFLICT (slug) DO NOTHING;

-- Insert the Research sub-agent
INSERT INTO agents (slug, display_name, type, description, is_active)
VALUES (
  'research',
  'Research Agent',
  'sub-agent',
  'Web research and knowledge retrieval sub-agent',
  true
)
ON CONFLICT (slug) DO NOTHING;

-- Insert the Email Writer sub-agent
INSERT INTO agents (slug, display_name, type, description, is_active)
VALUES (
  'email-writer',
  'Email Writer',
  'sub-agent',
  'Professional email drafting sub-agent: research → draft → review workflow',
  true
)
ON CONFLICT (slug) DO NOTHING;

-- Verify insertion
SELECT id, slug, display_name, type FROM agents ORDER BY created_at;
