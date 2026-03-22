# TrustCore Engine — Build Progress

## ✅ OVERNIGHT BUILD COMPLETE — RESOURCE MANAGER LIVE

All phases complete as of 2026-03-22. Both test suites passing (28/28). TypeScript clean.

### Session 7 — 2026-03-22 Layout Restore + Chat Tab

**Fix** — Restored original Tasks layout: left sidebar (Agents), center (TaskBoard full width), right (MemoryFeed); ChatPanel removed from Tasks page
**Fix** — Chat moved to dedicated **Chat tab** between Tasks and Memories; full-page centered chat layout (max-width 720px conversation column) matching original design language
**Fix** — ChatPanel CSS rewritten for full-page use: 12px border-radius bubbles, centered message column, full-width input bar with `inputInner` centering, thinking dots retained
**Verified** — WebSocket on `ws://localhost:3003` connects and receives events; heartbeat green (Alex alive, 60s interval); `/api/agents` returns 5 agents with CORS `*`; "Reconnecting..." was stale UI state cleared on page refresh

### Session 6 — 2026-03-22 Chat Panel + Dashboard Dockerization

**Phase D1** — Dashboard Dockerized: `Dockerfile.dashboard` (Next.js build + `npm start`); `dashboard` service added to `docker-compose.yml` on port 3004 (3000 reserved for local dev); stack now fully `docker compose up -d`
**Phase D2** — `POST /api/chat`: creates task assigned to Alex, long-polls 90s (60 × 1.5s) for completion, returns `{taskId, status, result}` or `timeout: true` if still running; refreshes task board via mutate
**Phase D3** — `ChatPanel.tsx`: persistent conversation UI — user messages right-aligned, agent left-aligned with avatar, animated thinking dots (3-dot bounce), `pre`-formatted result text, task ID footer, Shift+Enter for newlines; wired to Tasks tab alongside MemoryFeed
**Fix** — TaskBoard: added `cancelled` column (slate/grey) so cancelled tasks are visible in the 5th column

### Session 5 — 2026-03-22 Calendar Tab + KB Ingest + Vector Fix

**Fix** — Vector search ordering: `CASE WHEN embedding IS NOT NULL THEN embedding <=> $N END NULLS LAST, importance DESC, created_at DESC` — null-embedding rows now returned correctly with stable secondary sort; fixes flaky test when heartbeat records outnumber limit
**Fix** — `trustcore-agent-v1` display_name corrected in DB: `qwen2.5:0.5b` → `TrustCore Agent v1`
**Phase C1** — `POST /api/knowledge`: paragraph-chunked text ingestion (~500 chars/chunk), nomic-embed-text embedding per chunk, stored in knowledge_base
**Phase C2** — `GET /api/activity?hours=N`: hourly task bucket aggregation (created/completed/failed), recent 20 tasks with agent name join
**Phase C3** — `CalendarView.tsx`: stacked hourly bar chart (purple/green/red segments), recent task timeline with status dots, `IngestForm` (title + source + content → POST /api/knowledge); Calendar tab wired — all 7 tabs now have real content, no more placeholders

### Session 4 — 2026-03-22 Stats View + KB Viewer + Email Web Search

**Phase S1** — `GET /api/stats` endpoint: per-agent task counts (total/completed/failed/24h), task breakdown by status, memory event counts by type, system last-heartbeat + avg duration
**Phase S2** — `StatsView.tsx` wired to Projects tab: health row (heartbeat age, success rate, avg duration), agent performance cards with success-rate bars, task distribution bar chart, memory activity table; 10s SWR polling
**Phase S3** — Email-writer web search: DuckDuckGo context injected before LLM draft step when KB has no hits; uses same `webSearch()` tool as research agent
**Phase S4** — Docs tab: knowledge base viewer with source sidebar, chunk list, content preview, search filter; backed by `GET /api/knowledge?source=X&limit=N`

### Session 3 — 2026-03-22 Agent Activation + Web Search

**Fix 1** — Ollama volume mount: `docker-compose.yml` changed `/mnt/c/Users/Admin/.ollama` → `C:/Users/Admin/.ollama`; models (qwen3.5:35b, qwen3.5:9b, nomic-embed-text) now visible inside container
**Fix 2** — Alex unassigned task pickup: `pollPendingTasks` used `JOIN` that silently skipped tasks with `NULL assigned_to_agent_id`; changed to `LEFT JOIN ... OR IS NULL`
**Fix 3** — LLM timeouts raised: inner AbortController 115s → 300s; queue `REQUEST_TIMEOUT_MS` 180s → 360s; large models (qwen3.5:9b, 6.6GB) need ~2 min to swap into VRAM
**Fix 4** — `detectStubResult` tightened: stopped scanning LLM-generated text for keywords (false positives); now uses explicit `source` field markers only

**Phase R1** — Research agent wired to LLM: KB lookup + qwen3.5:9b synthesis; returns real answers with KB context injection when available
**Phase R2** — Web search added to research agent: DuckDuckGo HTML scrape (no API key), top-5 results extracted, injected as search context into LLM prompt
**Phase R3** — Task result display in dashboard: TaskBoard cards show expandable result panel with answer text, email body, source attribution

### Session 2 — 2026-03-22 Fixes and Resource Manager

**Fix 1** — Task failure detection: `SubAgent.detectStubResult()` catches `model='stub'` and body keywords, marks failed not completed
**Fix 2** — Memory writes: `writeUnifiedMemory`/`writeOwnMemory` no longer use `::vector` cast for null; `log()`/`remember()` in SubAgent wrapped in try/catch — never crash the agent loop
**Fix 3** — Agent memory endpoint: fixed `am.event_type` → `am.memory_type` column alias
**Fix 4** — Heartbeat: Alex now writes `event_type='heartbeat'` to `unified_memory` every 60s
**Fix 5** — `unified_memory_event_type_check` constraint updated to include `'heartbeat'` and `'system_alert'`

**Phase 1** — `gpu_metrics` table updated: renamed columns to `memory_used_mb/free_mb/total_mb/utilization_percent`, added `temperature_c`
**Phase 2** — Resource manager rebuilt: temperature, `canLoadModel()`, 30-min unified_memory summaries, `system_alert` on >80% util, mock fallback when nvidia-smi unavailable
**Phase 3** — LLM queue rebuilt: 180s timeout, EventEmitter events (queued/started/completed/failed/timeout), modelName+modelSizeGB tracking
**Phase 4** — LLM client fully wired through queue: all calls enqueued with priorities (1=alex, 2=agent, 3=embed, 4=factory), model size estimation for GPU routing
**Phase 5** — `GET /api/gpu/history?minutes=N` endpoint added
**Phase 6** — `OfficeView.tsx`: GPU cards with VRAM/util/temp bars, factory indicator, queue panel, 60-min SVG sparkline charts; wired to Office tab
**Phase 7** — `trustcore-resource-manager` Docker service added; `GET /api/gpu` falls back to DB when in-memory empty
**Phase 8** — `ARCHITECTURE.md` Part 6 added: two-GPU strategy, BSOD incident, resource manager, priority queue, Office view guide

---

## Overnight Build — 2026-03-21

### Phase O1 — LLM Timeout ✅ COMPLETE
- 120s AbortController timeout on all LLM calls in `src/llm/client.ts`
- Prevents tasks from hanging indefinitely in `in_progress`

### Phase O2 — Infrastructure Safety ✅ COMPLETE
- `OLLAMA_MAX_LOADED_MODELS=1` verified in `docker-compose.yml`
- Documented in `ARCHITECTURE.md` Part 5b with full rationale

### Phase O3 — Resource Manager ✅ COMPLETE
- `src/resource-manager/index.ts` — nvidia-smi poll every 10s
- `db/migrations/012_create_gpu_metrics.sql` — applied to DB
- `getGPUStatus()` and `recommendGPU(modelSizeGB)` exported
- Writes importance-4 unified_memory events when GPU > 80%

### Phase O4 — LLM Priority Queue ✅ COMPLETE
- `src/resource-manager/queue.ts` — min-heap, priorities 1–4
- Max 2 concurrent, max 50 queued, rejects with error when full
- Logs to unified_memory when depth ≥ 3

### Phase O5 — .gitignore Cleanup ✅ COMPLETE
- Removed all `.next` build artifacts from git tracking

### Phase O6 — MemoryView Component ✅ COMPLETE
- `apps/dashboard/components/MemoryView.tsx`
- Paginated (50/page), filterable by agent + type, searchable, expandable

### Phase O7 — AgentsView Component ✅ COMPLETE
- `apps/dashboard/components/AgentsView.tsx`
- Shows all agents; click to expand recent agent_memory entries

### Phase O8 — Dashboard Navigation ✅ COMPLETE
- Header tabs: Tasks, Memories, Team, Calendar, Projects, Docs, Office
- Memories → MemoryView; Team → AgentsView; others → placeholders

### Phase O9 — New API Endpoints ✅ COMPLETE
- `GET /api/agents/:slug/memories`
- `GET /api/gpu`
- `GET /api/queue`
- `GET /api/heartbeat`

### Phase O10 — Heartbeat Health Indicator ✅ COMPLETE
- HeartbeatIndicator in header: green (<2m), yellow (2–5m), red (>5m)

### Phase O11 — Docker Compose Cleanup ✅ COMPLETE
- Removed obsolete `version: '3.9'` line — no more warning

### Phase O12 — Architecture Documentation ✅ COMPLETE
- ARCHITECTURE.md Part 5b: Infrastructure Safety Settings
- Resource manager, GPU routing, OLLAMA_MAX_LOADED_MODELS, LLM timeout all documented

---

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
