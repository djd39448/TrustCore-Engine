# TrustCore Engine

**Locally-hosted, always-on AI agent framework with persistent memory and sub-agent orchestration.**

TrustCore is the antithesis of cloud-dependent AI systems. It's designed for organizations that need:
- Full local control (no API calls home)
- Persistent, searchable memory across sessions
- Autonomous agent swarms with specialization
- Always-on readiness with single-button deployment

## Vision

**One-button startup**: `docker compose up -d && bash scripts/migrate.sh`. Everything auto-wires on launch — Ollama LLM server, PostgreSQL database, memory system ready.

**Three-tier architecture**:
1. **Mission Control** — Next.js web UI (separate repo, single pane of glass)
2. **Alex** — Chief of staff agent, always running, persistent memory, orchestrates sub-agents
3. **Sub-agent swarm** — Specialized Docker containers, each with tools, skills, and RAG knowledge bases

## Core Design: Two-Tier Memory

The most important architectural decision is how agents remember.

### Unified Memory (Shared Consciousness)
Every agent reads it. Each agent writes only about its own actions.

**Example**: "Yesterday Dave asked Alex to send an email. Alex called the email-writer agent. Draft approved. Mailbox agent sent it."

- Event-based structure (task_started, task_completed, agent_called, user_interaction)
- Importance-weighted (1–5) for ranking in retrieval
- Embedded for semantic search + SQL filters
- Session-aware but not session-limited (survives restarts)

### Individual Memory (Agent's Personal Journal)
Private to each agent. Granular operational detail.

**Example**: "Received task from Alex. Ran research workflow. Checked brand voice doc. Wrote 3 drafts. Alex approved draft 2 with one edit. Recorded feedback for future reference."

- Workflow steps, tool details, feedback, learned preferences
- Embedded for semantic retrieval
- Includes optional backlinks to unified events for reconstruction
- Agent-only read access

## Database Schema

### Tables

| Table | Purpose | Rate | Embedded |
|-------|---------|------|----------|
| `agents` | Agent registry (slug, type, docker_image) | Low | No |
| `sessions` | Bounded interaction windows (for querying, not limiting) | Low | No |
| `unified_memory` | Shared events across all agents | Medium | Yes (768-dim) |
| `agent_memory` | Per-agent private journals | High | Yes |
| `tasks` | First-class task tree (subtask hierarchy) | Medium | No |
| `agent_tool_calls` | Raw operational log (tool name, input, output) | Very High | No |
| `memory_consolidations` | Rollup records for long-term compression | Low | No |
| `knowledge_base` | RAG chunks per-agent or global | Low-Medium | Yes |

### Key Design Decisions

#### Embedding Dimension: 768
- Matches `nomic-embed-text` (local, via Ollama)
- Balanced: faster than 1536, better quality than 384
- Tracked via `embedding_model` column for future model migrations

#### Consolidation Architecture
- Alex's heartbeat periodically rolls up old unified memories into `consolidation_summary` records
- Original memories marked with `is_consolidated = true` and `consolidation_id` FK
- Summaries get embeddings and participate in normal retrieval
- "Expand this summary" is just `SELECT * FROM unified_memory WHERE consolidation_id = $id`
- Immutable audit trail + fast retrieval ✓

#### Soft Deletes
- Memories are never hard-deleted
- Mark as `is_archived = true` to exclude from hot retrieval
- Preserves audit trail for compliance and debugging

## MCP Tool Surface

Agents interact with memory via Model Context Protocol:

```
read_unified_memory(query, limit, filters?)
  → semantic search + importance ranking + SQL filters

write_unified_memory(event_type, summary, content, importance?)
  → log action to shared consciousness

read_own_memory(query, limit, filters?)
  → agent reads its own private journal

write_own_memory(memory_type, summary, content, importance?)
  → personal detail logging

log_tool_call(tool_name, input, output, status, duration_ms?)
  → operational instrumentation

create_task(title, description, assigned_to?)
  → spawn new task tree node

update_task(id, status, result?)
  → mark progress

search_knowledge_base(query, limit?)
  → hybrid global + agent-specific RAG
```

## Quick Start

### Prerequisites
- Docker & Docker Compose
- `psql` CLI (or use container exec)
- Node.js 18+ (for future server code)

### Boot Up

```bash
# 1. Copy config
cp .env.example .env
# Edit .env — at minimum set POSTGRES_PASSWORD

# 2. Start containers
docker compose up -d

# 3. Wait for postgres health check
docker compose logs postgres
# Look for: "database system is ready to accept connections"

# 4. Run migrations
bash scripts/migrate.sh

# 5. Seed initial agents
source .env
psql $DATABASE_URL -f db/seed.sql

# 6. Verify
psql $DATABASE_URL -c "SELECT slug, type FROM agents;"
# Should show: alex (chief), system (system)
```

### Verify the Schema
```bash
source .env
psql $DATABASE_URL -c "\dt"  # List all tables
psql $DATABASE_URL -c "\d unified_memory"  # Inspect unified_memory
```

## Migration Strategy

Migrations live in `db/migrations/` and are numbered sequentially. Always run them in order:

```bash
bash scripts/migrate.sh
```

This script:
1. Connects to the database (using `$DATABASE_URL`)
2. Runs all `.sql` files in `db/migrations/` in sorted order
3. Exits on first error

**Important**: Migration 007 resolves a circular foreign key between `unified_memory` and `memory_consolidations`. Don't skip it.

## Phase 2 Roadmap

- **L1**: Memory consolidation heartbeat in Alex
- **L2**: Per-agent knowledge base (RAG) ingestion pipeline
- **L3**: Training factory to fine-tune local LLMs for specific sub-agents
- **L4**: Cloud fallback API/OAuth integration for complex reasoning
- **L5**: Mission Control UI (Next.js) with real-time agent dashboards

## Architecture Diagrams

```
┌─────────────────────────────────────────────────────────────┐
│                     Mission Control (UI)                    │
│                       (Next.js, Phase 2)                    │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP/WS
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                        Alex Agent                           │
│          (Always-on, reads from shared memory)              │
│  Task orchestration ─→ Spawns subtasks → Polls sub-agents  │
└────┬─────────────────────────────────────────────────────────┘
     │ MCP tool calls
     ▼
┌─────────────────────────────────────────────────────────────┐
│          PostgreSQL with pgvector                           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Unified Memory   │ Agent Memory  │ Tasks             │  │
│  │ (Shared events)  │ (Journals)    │ (Tree structure)  │  │
│  │ + Embeddings     │ + Embeddings  │ + Results         │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Consolidations   │ Tool Calls    │ Knowledge Base    │  │
│  │ (Rollups)        │ (Raw logs)    │ (RAG chunks)      │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
     │ MCP memory tools
     ▼
┌─────────────────────────────────────────────────────────────┐
│                   Sub-Agent Swarm                           │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │ Email      │  │ Research   │  │ Scheduling │             │
│  │ Writer     │  │ Agent      │  │ Agent      │  ...        │
│  │ (Docker)   │  │ (Docker)   │  │ (Docker)   │             │
│  └────────────┘  └────────────┘  └────────────┘             │
│  Each: tools, embeddings, private memory, RAG               │
└─────────────────────────────────────────────────────────────┘
```

## File Structure

```
trustcore-engine/
├── .env.example                    # Environment template
├── .gitignore
├── docker-compose.yml              # PostgreSQL + Ollama
├── package.json
├── tsconfig.json
├── README.md (this file)
│
├── scripts/
│   └── migrate.sh                  # Run migrations in order
│
└── db/
    ├── schema.sql                  # Combined reference (generated)
    ├── seed.sql                    # Initial agents
    │
    └── migrations/
        ├── 001_enable_pgvector.sql          # CREATE EXTENSION pgvector
        ├── 002_create_agents.sql            # agents table
        ├── 003_create_sessions.sql          # sessions table
        ├── 004_create_tasks.sql             # tasks table (hierarchical)
        ├── 005_create_unified_memory.sql    # unified_memory table
        ├── 006_create_memory_consolidations.sql  # memory_consolidations table
        ├── 007_add_consolidation_fk.sql    # Add FK from unified_memory to consolidations
        ├── 008_create_agent_memory.sql      # agent_memory table
        ├── 009_create_agent_tool_calls.sql  # agent_tool_calls table
        ├── 010_create_knowledge_base.sql    # knowledge_base table
        └── 011_create_indexes.sql           # All performance indexes
```

## Development Notes

- **Always run migrations in order** — they have internal dependencies
- **IVFFlat index warnings on empty tables are harmless** — disappear after first insert
- **Embedding model mismatch will silently fail at retrieval** — always verify `embedding_model` when adding vectors
- **Session boundaries are optional** — memories exist independently; sessions are for querying ("what happened yesterday?")
- **Alex is always-on** — system startup should spawn the Alex container first, wait for postgres health, then run migrations

## Next Steps

1. Boot the system: `docker compose up -d && bash scripts/migrate.sh`
2. Verify schema: `psql $DATABASE_URL -f db/seed.sql`
3. Implement Alex's main loop (always-on, reads MCP tools, processes tasks)
4. Implement MCP server exposing memory tools
5. Implement stub sub-agents as Docker containers