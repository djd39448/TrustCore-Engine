# TrustCore Engine

**Locally-hosted, always-on AI agent framework with persistent memory and sub-agent orchestration.**

TrustCore is the antithesis of cloud-dependent AI systems — designed for organizations that need full local control, persistent searchable memory, autonomous agent swarms, and always-on readiness.

---

## Quick Start

```bash
# 1. Clone and configure
git clone <repo-url>
cd TrustCore-Engine
cp .env.example .env        # edit DATABASE_URL, OLLAMA_HOST if needed

# 2. Start infrastructure
docker compose up -d postgres ollama

# 3. Run database migrations
bash scripts/migrate.sh

# 4. Seed agents
docker exec trustcore-postgres psql -U trustcore -d trustcore_memory -f /migrations/seed.sql

# 5. Pull Ollama models (first time only)
docker exec trustcore-ollama ollama pull llama3.2
docker exec trustcore-ollama ollama pull nomic-embed-text

# 6. Install Node dependencies
npm install

# 7. Run tests to verify everything
npm test

# 8. Start the full agent stack
npm run dev:alex &          # Alex chief-of-staff loop
npm run dev:research &      # Research sub-agent
npm run dev:email-writer &  # Email Writer sub-agent
npm run dev:api             # Mission Control API (port 3002)

# 9. Open the Mission Control dashboard
cd apps/dashboard && npm install && npm run dev
# → visit http://localhost:3000
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Mission Control UI                          │
│              Next.js dashboard  (port 3000)                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │  HTTP + WebSocket
┌──────────────────────────▼──────────────────────────────────────┐
│                    Mission Control API                           │
│              Express + WebSocket  (port 3002)                   │
│  GET /api/agents  /api/tasks  /api/memories  /api/tool-calls    │
│  POST /api/tasks                                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │  PostgreSQL  (port 5432)
┌──────────────────────────▼──────────────────────────────────────┐
│                    TrustCore Database                            │
│   pgvector/pgvector:pg16 — 8 tables, vector(768) embeddings     │
│   agents │ tasks │ unified_memory │ agent_memory                 │
│   sessions │ memory_consolidations │ agent_tool_calls            │
│   knowledge_base                                                 │
└──────────┬───────────────┬───────────────────────────────────────┘
           │               │
┌──────────▼──────┐  ┌─────▼──────────────────────────────────────┐
│   Alex (chief)  │  │           Sub-agent Fleet                   │
│  60s heartbeat  │  │  Research Agent  │  Email Writer  │  ...    │
│  Task routing   │  │  (30s poll loop each)                       │
│  Memory consol. │  └─────────────────────────────────────────────┘
└──────────┬──────┘
           │  classifyTaskIntent() → LLM or keyword fallback
           │  dispatch() → child task in DB → sub-agent polls
┌──────────▼──────┐
│  Ollama  (LLM)  │
│  llama3.2       │
│  nomic-embed    │
│  (port 11434)   │
└─────────────────┘
```

---

## Source File Reference

### Core

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — dispatches to alex / research / email-writer / api / mcp / mc-mcp |
| `src/config.ts` | Typed config: reads all env vars, validates on startup |
| `src/db/client.ts` | PostgreSQL pool + typed `query()` helper; inline .env loader |

### MCP Servers

| File | Purpose |
|------|---------|
| `src/mcp/tools.ts` | All 8 agent tool implementations (read/write memory, tasks, KB, tool calls) |
| `src/mcp/server.ts` | Agent tools MCP server (stdio) — used by agent processes |
| `src/mcp/mission-control-server.ts` | Read-only MCP server for the dashboard — get_recent_activity, get_tasks, get_agents, get_consolidations |

### Agents

| File | Purpose |
|------|---------|
| `src/agents/base/SubAgent.ts` | Abstract base class: poll loop, handleTask(), log(), remember(), instrument() |
| `src/agents/registry.ts` | Agent registry + `dispatch()` — creates child tasks, logs to shared memory |
| `src/agents/alex/index.ts` | Alex always-on loop: heartbeat, task orchestration, memory consolidation |
| `src/agents/research/index.ts` | Research sub-agent: KB lookup → stub live research |
| `src/agents/email-writer/index.ts` | Email Writer: research → draft → review (3-step LLM workflow) |

### Embedding + LLM

| File | Purpose |
|------|---------|
| `src/embedding/client.ts` | Ollama nomic-embed-text client; URL normalization; graceful fallback |
| `src/llm/client.ts` | Ollama chat completion; `classifyTaskIntent()` for task routing |

### API + Dashboard

| File | Purpose |
|------|---------|
| `src/api/server.ts` | Express HTTP + WebSocket API (port 3002); broadcasts live events |
| `apps/dashboard/` | Next.js 15 Mission Control: AgentSidebar, TaskBoard (kanban), MemoryFeed (live WS) |

### Scripts

| File | Purpose |
|------|---------|
| `scripts/test-memory.ts` | 14-test suite: DB, memory CRUD, task lifecycle, tool calls, KB |
| `scripts/integration-test.ts` | End-to-end: Alex → email-writer task chain, full memory verification |
| `src/scripts/ingest.ts` | KB ingestion: chunk + embed text/code files into knowledge_base |

---

## How to Add a New Sub-agent

1. **Create** `src/agents/<slug>/index.ts` extending `SubAgent`:
   ```typescript
   import { SubAgent, type TaskRecord } from '../base/SubAgent.js';
   export class MyAgent extends SubAgent {
     constructor() { super('my-agent', 'My Agent'); }
     async handleTask(task: TaskRecord): Promise<unknown> {
       // do work, return result
     }
   }
   new MyAgent().start();
   ```

2. **Register** the slug in `src/agents/registry.ts`:
   ```typescript
   export const REGISTERED_AGENTS = new Set(['research', 'email-writer', 'my-agent']);
   ```

3. **Seed** the agent in `db/seed.sql`:
   ```sql
   INSERT INTO agents (slug, display_name, type, description, is_active)
   VALUES ('my-agent', 'My Agent', 'sub-agent', 'Does X', true)
   ON CONFLICT (slug) DO NOTHING;
   ```

4. **Wire** dispatch mode in `src/index.ts`:
   ```typescript
   } else if (mode === 'my-agent') {
     await import('./agents/my-agent/index.js');
   }
   ```

5. **Teach Alex** to route tasks to it — add keywords or update the LLM system prompt in `src/llm/client.ts`.

---

## How Memory Consolidation Works

Alex runs a consolidation pass on every heartbeat (default 60s):

```
1. Find unified_memory rows where:
   - is_consolidated = false
   - is_archived = false
   - importance <= 2
   - created_at < NOW() - 7 days

2. Ask LLM to summarize the batch into 2-3 sentences
   (falls back to bullet list if Ollama is unavailable)

3. Write the summary as a new unified_memory row (event_type = consolidation_summary)

4. Insert a memory_consolidations record linking to that summary row,
   capturing the time range and memory count

5. Mark all source rows is_consolidated = true, consolidation_id = <new record>
```

This keeps the shared memory searchable without unbounded growth.

---

## Environment Variable Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://trustcore:changeme@localhost:5432/trustcore_memory` | PostgreSQL connection string |
| `DB_POOL_MAX` | `10` | Max DB pool connections |
| `OLLAMA_HOST` | `localhost:11434` | Ollama server URL (http:// added automatically) |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model (`:latest` appended if no tag) |
| `LLM_MODEL` | `llama3.2` | LLM chat model for Alex and sub-agents |
| `EMAIL_WRITER_MODEL` | `(LLM_MODEL)` | Override model for Email Writer specifically |
| `ALEX_HEARTBEAT_MS` | `60000` | Alex heartbeat interval in ms |
| `RESEARCH_POLL_MS` | `30000` | Sub-agent poll interval in ms |
| `CONSOLIDATION_AGE_DAYS` | `7` | Days before memories eligible for consolidation |
| `CONSOLIDATION_BATCH` | `50` | Max memories consolidated per pass |
| `API_PORT` | `3002` | Mission Control API port |
| `MCP_PORT` | `3001` | MCP server port |
| `INGEST_CHUNK_SIZE` | `1500` | KB ingestion characters per chunk |
| `INGEST_OVERLAP` | `200` | KB ingestion overlap between chunks |

---

## Running Tests

```bash
npm test                  # runs both test suites
npm run test:memory       # 14 unit tests (DB, memory, tasks, KB)
npm run test:integration  # end-to-end orchestration scenario
```

Both exit with code 0 on success, 1 on failure (CI-friendly).
