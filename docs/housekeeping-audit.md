# TrustCore Engine — Housekeeping Audit
**Date:** March 27, 2026
**Session:** Architecture alignment, code cleanliness, data discipline
**Status:** Report only — no code was changed in this audit

---

## Track 2 — Codebase Audit

### 2a — Agent Name Audit

**"research-agent" occurrences:**
No literal string `research-agent` found in any file. However, a significant naming mismatch exists between the architecture and the implementation:

- ARCHITECTURE.md calls this agent **Sage**
- The implementation uses the slug **`research`** throughout:
  - `src/agents/registry.ts` — REGISTERED_AGENTS includes `'research'`
  - `docker-compose.yml:117` — service named `research:`
  - `docker-compose.yml:123-124` — `AGENT_MODE: research` and command arg `"research"`
  - `db/seed.sql:28-36` — agent slug registered as `'research'`
  - `src/agents/alex/index.ts:608` — routing comment references `'research'`
  - `src/llm/client.ts:293` — classifyTaskIntent() routes to `"research"`

**Action needed:** Reconcile. Either rename the service/slug to `sage` in code, or accept that "Sage" is the display name / character name and "research" is the internal slug. This is an intentional design decision that needs to be made explicit.

**"Tim the Toolman Taylor" occurrences:**
None found in any file. All prior occurrences were cleaned in today's ARCHITECTURE.md housekeeping commit.

**email-writer as primary routing target:**
email-writer is correctly registered and routable. `classifyTaskIntent()` includes it as a valid routing target. This is correct — email-writer is on The Bench but still callable. No issue.

**eval as agent identity name:**
All `eval` references are service-level (`trustcore-eval`, `EVAL_PORT`, docker-compose service). No identity/character-level misuse found. Acceptable.

---

### 2b — Dead Import and Dead Code Audit

**vendor/asbcp-core directory:**
`vendor/asbcp-core/` exists in the repo root and contains 50+ compiled files (.js, .d.ts, .map, schema files). However, **no imports from this directory were found in any src/ file**. This directory appears to be a stale build artifact or a vendor snapshot that was never integrated.

**Action needed:** Confirm unused, then delete.

**Heartbeat pulses to unified_memory:**
No heartbeat `INSERT INTO unified_memory` found. Heartbeat correctly writes to `agents.last_seen` via `UPDATE agents SET last_seen = NOW()` in:
- `src/agents/alex/index.ts:551`
- `src/mcp/tools.ts:451-453`
- `src/agents/eval/server.ts:100`

✅ Correct.

**Direct SQL to MemoryCore tables:**
Read-only `SELECT` queries to `memory_chunks` and `memory_summaries` found in `src/agents/alex/index.ts` at lines 1165, 1285, 1453, 1457, 1468. These are read operations for memory context retrieval and semantic search — not writes. No `INSERT`, `UPDATE`, or `DELETE` to these tables found outside MemoryCore. Acceptable.

**"depth" column references:**
None found in any file. The column was removed and the fix was previously applied. ✅ Clean.

---

### 2c — Configuration Drift Audit

**OLLAMA_NUM_CTX:**
- `docker-compose.yml:105` — Alex: `OLLAMA_NUM_CTX: "8192"` ✅ Correct
- `src/llm/client.ts:25` — default fallback: `parseInt(process.env['OLLAMA_NUM_CTX'] ?? '4096')` — Sub-agents on GPU0 will use 4096 if not set. No `OLLAMA_NUM_CTX` is set for eval, research, or email-writer services in docker-compose. This is intentional (smaller context for task-specific agents) but is worth documenting explicitly.

**Service naming:**
- `research` service is still named `research` in docker-compose.yml, not `sage`. See 2a above.

**Model names:**
- Alex: `qwen2.5:14b` ✅
- Eval: `qwen2.5:7b` ✅
- Research: `qwen3.5:9b` — note: this is qwen3.5, not qwen2.5. May be intentional (newer model) but not in the architecture's model registry table.
- Email-writer: `qwen3.5:9b` — same note.

These may be deliberate upgrades. Flag for confirmation but not necessarily wrong.

**Dockerfile references:**
All services use `Dockerfile.agent.extended`. No legacy `Dockerfile.agent` references found. ✅ Correct.

---

### 2d — Database Schema vs Code Audit

**Tables in migrations (complete list):**

| Table | Migration File |
|-------|---------------|
| agents | 002_create_agents.sql |
| sessions | 003_create_sessions.sql |
| tasks | 004_create_tasks.sql |
| unified_memory | 005_create_unified_memory.sql |
| memory_consolidations | 006_create_memory_consolidations.sql |
| agent_memory | 008_create_agent_memory.sql |
| agent_tool_calls | 009_create_agent_tool_calls.sql |
| knowledge_base | 010_create_knowledge_base.sql |
| gpu_metrics | 012_create_gpu_metrics.sql |
| eval_scores | 013_create_eval_tables.sql |
| memory_chunks | 016_memory_core.sql |
| memory_summaries | 016_memory_core.sql |
| memory_archive | 016_memory_core.sql |
| chat_sessions | 018_chat.sql |
| chat_messages | 018_chat.sql |

**Note on ARCHITECTURE.md:** The doc refers to `memory_archives` (plural). The actual table is `memory_archive` (singular). Minor naming discrepancy to correct in ARCHITECTURE.md.

**Tables in code queries:** agents, sessions, tasks, unified_memory, memory_consolidations, agent_memory, agent_tool_calls, knowledge_base, gpu_metrics, eval_scores, memory_chunks, memory_summaries, chat_sessions, chat_messages — all match migrations. ✅

**Phantom tables (in code, not migrations):** None found.

**Dead migrations (in migrations, never queried):** None found.

**"depth" column in any table:** Not found. ✅

**Schema drift note:** The `knowledge_base` table does NOT have a `category` column. The ARCHITECTURE.md describes identity documents being stored with `category = 'identity'` — this is planned architecture not yet implemented in the schema. The actual schema uses `source` as the distinguishing field.

---

### 2e — Task Routing Audit

**classifyTaskIntent() routing targets** (`src/llm/client.ts:282-322`):
- `"research"` → research service
- `"email-writer"` → email-writer service
- `"alex"` → Alex handles directly
- `null` → no match / fallback

**REGISTERED_AGENTS** (`src/agents/registry.ts`):
- `'research'`
- `'email-writer'`

**Agent registry in seed.sql:**
- `system` (system type)
- `alex` (chief)
- `research` (sub-agent)
- `email-writer` (sub-agent)
- `eval` (sub-agent, callable via HTTP service on port 3005)

**Running services in docker-compose.yml:**
- postgres, ollama-gpu1, ollama-gpu0, eval, alex, research, mcp, email-writer, resource-manager, api, dashboard

**Cross-reference:** All routing targets (`research`, `email-writer`, `alex`) have corresponding running services. No orphaned routes. ✅

---

### 2f — Orphaned Files Audit

**Missing identity documents — PENDING AUTHORING:**

| Agent | Soul.md | Agent.md | User.md | Priority |
|-------|---------|----------|---------|----------|
| Alex | ✅ Present | ✅ Present | ✅ Present | — |
| Sage (research) | ❌ Missing | ❌ Missing | ❌ Missing | HIGH |
| Eve (eval) | ❌ Missing | ❌ Missing | ❌ Missing | HIGH |
| email-writer | ❌ Missing | ❌ Missing | ❌ Missing | MEDIUM (bench) |
| Archie | ❌ Missing | ❌ Missing | ❌ Missing | HIGH (not yet built) |

These are documented as pending in ARCHITECTURE.md ("Identity retrofits pending" section). Authoring must happen before the character training pipeline can run for these agents. Each document must reference Foundation.md as its highest governing principle.

**Stale/backup files:**
`.next/cache/webpack/` contains `.old` and `.gz.old` files — Next.js build cache artifacts, not project source files. Low priority.

**vendor/asbcp-core directory:**
Exists at `vendor/asbcp-core/` with 50+ compiled files. No imports found in src/. **Flag for deletion after confirming unused.**

**Schema files referencing retired agents:**
No stale schema files found in src/skill-library/. Only `cold-outreach.schema.json` exists and it references email-writer which is still callable. No issue.

**Agent .md files for non-running services:**
Only Alex has identity docs. No orphaned docs for non-existent agents found.

---

## Track 3 — Database Health

*Queries run against trustcore_memory on trustcore-postgres container, March 27, 2026.*

### 3a — Zombie Tasks (in_progress > 2 hours)

```
 id | title | assigned_to_agent_id | created_at | updated_at
----+-------+----------------------+------------+------------
(0 rows)
```

✅ No zombie tasks. All in-progress tasks are current.

### 3b — Memory Chunks Without Embeddings

```
 chunks_without_embeddings
---------------------------
                         0
(1 row)
```

✅ All 68 memory chunks have embeddings.

### 3c — Agent Registry

```
 id                                   | slug               | display_name       | type      | is_active | last_seen
--------------------------------------+--------------------+--------------------+-----------+-----------+-------------------------------
 192798d6-e307-4bfe-b275-3ed5e80d2b75 | email-writer       | Email Writer       | sub-agent | t         | 2026-03-27 14:48:30 UTC
 523f16c1-e1b1-473c-9911-21986dbc6071 | research           | Research Agent     | sub-agent | t         | 2026-03-27 14:48:30 UTC
 9dfeae88-379e-49cf-9437-f9cee39295b7 | alex               | Alex               | chief     | t         | 2026-03-27 14:48:14 UTC
 5e1c16ca-27f1-4824-8657-9ec9da737ecd | eval               | Eval Agent         | sub-agent | t         | 2026-03-27 14:48:04 UTC
 6ae9e8d0-b3b3-490a-a0aa-31e6fdc98565 | system             | System             | system    | t         | NULL
 207b6deb-7b07-40a6-a1cc-9f432ac8c349 | trustcore-agent-v1 | TrustCore Agent v1 | sub-agent | t         | NULL
```

**Cross-reference with docker-compose.yml:**
- `alex` ✅ Running service, active
- `research` ✅ Running service, active
- `email-writer` ✅ Running service, active
- `eval` ✅ Running service, active
- `system` — No service (expected — background system agent)
- `trustcore-agent-v1` ⚠️ **No corresponding running service in docker-compose.yml.** This agent has a DB record but no container. last_seen is NULL. May be a legacy registration from early development. Flag for review.

**Missing from DB but in docker-compose:**
- `resource-manager` — no agent DB row (expected — not an LLM agent, is a service)
- `mcp` — no agent DB row (expected — infrastructure service)
- `api` — no agent DB row (expected — API server)

### 3d — Orphaned Eval Scores

```
 orphaned_eval_scores
----------------------
                    0
(1 row)
```

✅ No orphaned eval scores. All eval_scores rows have valid task references.

### 3e — Memory Chunks Without Agent

```
 chunks_without_agent
----------------------
                    0
(1 row)
```

✅ All 68 memory chunks have agent_id set.

### 3f — Sessions Without Corresponding Agent

Sessions table does not have an `agent_id` column — it uses `initiated_by` (text: 'user' | 'system' | 'scheduled'). Query is not applicable to this schema. No orphaned session → agent relationships to check.

### 3g — Stale Knowledge Base Entries (> 30 days, not identity)

```
 id | agent_id | source | title | created_at | updated_at
----+----------+--------+-------+------------+------------
(0 rows)
```

✅ No stale knowledge base entries. Note: `knowledge_base` table does not have a `category` column — the identity document storage via `category = 'identity'` described in ARCHITECTURE.md is not yet implemented in the schema.

### 3h — Ghost depth Column Check

```
 column_name | table_name
-------------+------------
(0 rows)
```

✅ No `depth` column exists in any public table. Previously removed column is fully gone.

---

## Additional DB Stats

| Metric | Value |
|--------|-------|
| Total tasks | 218 |
| Completed tasks | 212 (97%) |
| Failed tasks | 2 (1%) |
| Cancelled tasks | 4 (2%) |
| In-progress tasks | 0 |
| Memory chunks total | 68 |
| Memory summaries total | 3 |
| Chunks without embeddings | 0 |
| Orphaned eval scores | 0 |

---

## Summary of Findings Requiring Action

| Priority | Finding | Action |
|----------|---------|--------|
| HIGH | Sage/Eve/Archie missing identity documents | Author Soul.md, Agent.md, User.md before next factory run |
| MEDIUM | research vs Sage naming — slug vs display name | Decide: rename slug to `sage` or document that "Sage" is character name, "research" is slug |
| MEDIUM | `trustcore-agent-v1` agent record in DB with no running service | Review and retire if legacy |
| LOW | `vendor/asbcp-core/` directory — no imports found | Confirm unused, delete |
| LOW | `memory_archive` vs `memory_archives` — table name vs ARCHITECTURE.md name | Fix ARCHITECTURE.md reference |
| LOW | `knowledge_base` missing `category` column | Implement or update architecture doc to reflect actual schema |
| INFO | qwen3.5:9b used by research and email-writer (ARCHITECTURE.md shows qwen2.5:7b) | Intentional upgrade or drift — confirm |
| INFO | 4096 default OLLAMA_NUM_CTX for sub-agents (no explicit override in docker-compose) | Intentional (small context for narrow agents) — document |
