# TrustCore Engine — Build Progress

## Current Phase: Phase 4 — Mission Control UI

---

## Phase 1: Infrastructure ✅ COMPLETE
- [x] PostgreSQL + pgvector via Docker Compose
- [x] 11 migrations (all tables + indexes)
- [x] Seed: Alex (chief) + System agents
- [x] `.env` created from `.env.example`
- [x] Fixed: docker image tag `pg16-latest` → `pg16`
- [x] Fixed: extension name `pgvector` → `vector` in migration 001

---

## Phase 2: MCP Server + Alex Agent 🔄 IN PROGRESS

### 2a: Project scaffold + DB client ✅
- [x] npm install + `@modelcontextprotocol/sdk` + `@types/pg`
- [x] `src/db/client.ts` — pg pool, typed query helper (NodeNext ESM)
- [x] Fixed pgvector npm version `^0.1.10` → `^0.2.1`

### 2b: MCP tool implementations ✅
- [x] `read_unified_memory` — importance-ranked retrieval with filters
- [x] `write_unified_memory` — log event to shared consciousness
- [x] `read_own_memory` — agent reads own private journal
- [x] `write_own_memory` — personal detail logging
- [x] `log_tool_call` — operational instrumentation
- [x] `create_task` — spawn task tree node (requires `created_by` agent)
- [x] `update_task` — mark task progress
- [x] `search_knowledge_base` — by agent scope

### 2c: MCP server (stdio) ✅
- [x] `src/mcp/server.ts` — MCP protocol over stdio
- [x] Tool registration + dispatch for all 8 tools
- [x] Zod validation + typed error responses

### 2d: Alex main loop ✅
- [x] `src/agents/alex/index.ts` — always-on loop with 60s heartbeat
- [x] Polls pending tasks assigned to alex, marks in_progress → completed
- [x] Consolidation: rolls up old low-importance memories → memory_consolidations
- [x] Graceful SIGINT shutdown with final memory write
- [x] **Smoke tested** — connects to DB, writes startup event, heartbeat fires

---

## Phase 3: Sub-agents + Embedding Pipeline 🔄 IN PROGRESS

### 3a: Embedding pipeline ✅
- [x] `src/embedding/client.ts` — Ollama nomic-embed-text client
- [x] Wired into `writeUnifiedMemory`, `writeOwnMemory`
- [x] Vector search in `readUnifiedMemory`, `readOwnMemory`, `searchKnowledgeBase`
- [x] URL normalization: `0.0.0.0` → `localhost`, scheme + `:latest` tag auto-added
- [x] Graceful fallback to recency ranking when Ollama unavailable

### 3b: Sub-agent framework ✅
- [x] `src/agents/base/SubAgent.ts` — abstract base with poll/handle/log/remember/instrument
- [x] `src/agents/research/index.ts` — Research agent (KB lookup → stub live research)
- [x] `research` registered in DB + seed.sql
- [x] End-to-end: task created → Research picks up → completes with result JSON

### 3c: LLM + Orchestration + KB Ingestion ✅
- [x] `src/llm/client.ts` — Ollama chat completion client (llama3.2)
- [x] `classifyTaskIntent()` — LLM-based task router with keyword fallback
- [x] Alex orchestration: classify task → delegate to sub-agent or handle directly
- [x] LLM-generated summaries in memory consolidation
- [x] `src/scripts/ingest.ts` — Knowledge base ingestion: chunk + embed + store
- [x] `npm run ingest <path> [--agent slug] [--chunk-size N]`

---

## Phase 4: Mission Control UI 🔄 IN PROGRESS
- Next.js app (separate repo or `apps/dashboard/`)
- Real-time agent status board (tasks, memories, tool calls)
- PostgreSQL-backed, reads from same DB as agents

### 4a: API layer ✅
- [x] `src/api/server.ts` — Express HTTP API + WebSocket push
- [x] GET `/api/agents` — list all agents
- [x] GET `/api/tasks` — list tasks (filter by status, agent; paginated)
- [x] POST `/api/tasks` — create task (human-initiated)
- [x] GET `/api/memories` — unified memory feed (filter by agent, event_type; paginated)
- [x] GET `/api/tool-calls` — recent tool call log
- [x] GET `/api/knowledge` — knowledge base preview
- [x] GET `/health` — health check
- [x] WebSocket on same port — broadcasts task_update, memory_event, task_created
- [x] `npm run dev:api` — runs on port 3002 (API_PORT env override)
- [x] `api` service added to docker-compose.yml

### 4b: Dashboard UI
- [ ] Next.js app scaffolded
- [ ] Task board component (kanban by status)
- [ ] Memory feed component (real-time, WebSocket)
- [ ] Agent status sidebar

---

## Known Issues / Notes
- `psql` not available on host; use `docker exec trustcore-postgres psql ...`
- IVFFlat index warnings on empty tables are harmless (expected)
- ts-node ESM loader shows deprecation warning (cosmetic, non-breaking)
- Run Alex: `node --loader ts-node/esm src/index.ts alex` or `npm run dev:alex`
- Run Research: `node --loader ts-node/esm src/index.ts research` or `npm run dev:research`
- Run MCP server: `node --loader ts-node/esm src/index.ts`
- Ingest docs: `npm run ingest <path> [--agent <slug>]`
- LLM model: `llama3.2` (override with `LLM_MODEL` env var)
- Embedding model: `nomic-embed-text:latest` (override with `EMBEDDING_MODEL`)
