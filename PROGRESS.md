# TrustCore Engine — Build Progress

## ✅ BUILD COMPLETE

All phases complete. Both test suites passing (28/28). TypeScript clean.

---

## Summary of Everything Built

### Infrastructure (Phase 1)
- PostgreSQL + pgvector via Docker Compose (`pgvector/pgvector:pg16`)
- 11 migrations: agents, sessions, tasks, unified_memory, memory_consolidations, agent_memory, agent_tool_calls, knowledge_base + indexes
- Seed: system + alex + research + email-writer agents

### MCP Server + Tools (Phase 2)
- `src/mcp/tools.ts` — 8 tool implementations: read/write unified_memory, read/write own_memory, create/update task, log_tool_call, search_knowledge_base
- `src/mcp/server.ts` — MCP stdio server with Zod validation
- `src/mcp/mission-control-server.ts` — Read-only MCP server for dashboard: get_recent_activity, get_tasks, get_agents, get_consolidations

### Embedding + LLM (Phase 3a)
- `src/embedding/client.ts` — Ollama nomic-embed-text:latest, URL normalization, graceful fallback
- `src/llm/client.ts` — Ollama chat/prompt, classifyTaskIntent() with LLM + keyword fallback

### Agent Framework (Phase 3b)
- `src/agents/base/SubAgent.ts` — Abstract base: poll loop, log(), remember(), instrument()
- `src/agents/registry.ts` — dispatch() creates child tasks; getAgentStatuses() for dashboard
- `src/agents/alex/index.ts` — Chief-of-staff: 60s heartbeat, LLM-based task routing, memory consolidation with LLM digest
- `src/agents/research/index.ts` — KB lookup + stub live research
- `src/agents/email-writer/index.ts` — 3-step workflow: research → draft → review (configurable model)

### Config (Phase 12)
- `src/config.ts` — Typed central config with defaults, validation, redacted logging

### Knowledge Base Ingestion
- `src/scripts/ingest.ts` — Chunk text files + embed + store; `npm run ingest <path>`

### Mission Control API (Phase 4a)
- `src/api/server.ts` — Express HTTP API + WebSocket (port 3002)
- Endpoints: GET /api/agents, /api/tasks, /api/memories, /api/tool-calls, /api/knowledge; POST /api/tasks
- WS broadcasts: task_update, task_created, memory_event (2s poll)

### Dashboard UI (Phase 4b)
- `apps/dashboard/` — Next.js 15 App Router, no external UI library
- AgentSidebar: live agent list with type badges and active status
- TaskBoard: 4-column kanban (pending/in_progress/completed/failed), new-task modal, live highlights
- MemoryFeed: WebSocket real-time event stream, expandable content, relative timestamps

### Tests
- `scripts/test-memory.ts` — 14 unit tests: DB, memory CRUD, task lifecycle, tool calls, KB
- `scripts/integration-test.ts` — 14 end-to-end tests: Alex → email-writer chain, full memory verification

### Docker
- `docker-compose.yml` — postgres, ollama, alex, research, email-writer, mcp, api
- `docker-compose.dev.yml` — source volume mounts, Node debug ports, restart: no

### Docs
- `README.md` — Getting started, ASCII architecture diagram, file reference, how to add sub-agents, memory consolidation explanation, env var reference

---

## Key Decisions Made

1. **NodeNext ESM** — `module: NodeNext` required for `@modelcontextprotocol/sdk` exports map; all imports use `.js` extensions
2. **DB as message bus** — No IPC between agents; sub-agents poll the tasks table. Simple, observable, crash-safe.
3. **Graceful LLM degradation** — Every LLM/embedding call returns null on failure; callers fall back to heuristics. The system runs without Ollama.
4. **Registry validates before dispatch** — Alex can only dispatch to slugs in `REGISTERED_AGENTS` and active DB rows, preventing silent FK errors.
5. **Two-tier memory** — `unified_memory` = shared consciousness visible to all agents; `agent_memory` = private journal per agent.
6. **Keyword fallback classifier** — When Ollama is offline, Alex uses regex keyword matching (email→email-writer, research→research, else→alex).
7. **Mission Control API separate from MCP** — REST/WS API for the dashboard; MCP stdio for agent tooling. No coupling.
8. **pgvector cosine similarity** — `<=>` operator on vector(768) columns with IVFFlat indexes; falls back to recency+importance when embeddings are NULL.

---

## How to Run in the Morning

```bash
# Full stack (Docker)
docker compose up -d
npm test   # verify everything works

# Or local dev
npm run dev:alex &
npm run dev:research &
npm run dev:email-writer &
npm run dev:api &
cd apps/dashboard && npm run dev
```

Talk to Alex by creating a task via POST /api/tasks or the dashboard "+ New Task" button.
