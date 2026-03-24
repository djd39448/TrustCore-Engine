# TrustCore Build Session — Day 3 Notes
*March 23, 2026*

## What Was Built Today

### Fixes
- **Eval real scores** — EVAL_SYSTEM prompt was never being passed to chat(). Fixed. Now producing real scores: 4.43 approved, 1.60 needs_revision
- **Memory type filter** — Individual view in Memories tab now has dropdown filter for memory types
- **Code annotation pass** — 341 lines of JSDoc added across 6 core files
- **Stale eval scores flagged** — migration 014 adds calibration_void column, all pre-fix scores marked void
- **Agent sleep after task completion** — OLLAMA_KEEP_ALIVE now sent per-request. SubAgent.ts finally block always releases VRAM. guardAgentBusy() prevents double-dispatch. gpu0 confirmed 0 models loaded after completion.

### New Standards
- **Two-layer task schema** — All tasks now have sacred intent layer + Alex enrichment layer. SOP for all task types going forward. Committed as standard in ARCHITECTURE.md
- **Email schema wiring** — Alex passes full structured schema to email-writer. Eval receives original schema alongside output for context-aware scoring.
- **Eval rubric** — email-outreach type now has formal scoring rubric in eval agent

### New Files
- `FOUNDATION.md` — The why behind TrustCore. The highest governing document. Sits above ARCHITECTURE.md. Beneficiary placeholders [BENEFICIARY_1] and [BENEFICIARY_2] — names to be added by owner when ready.
- `src/agents/alex/SOUL.md` — Alex's identity document. Loaded synchronously at startup before first heartbeat. Written to unified_memory each session. Governs both orchestration and direct conversation.
- `ARCHITECTURE_part13.md` — appended to ARCHITECTURE.md as Part 13: External Intelligence Layer

### New Repository — ASBCP
- Created separate repo: TrustCore-ASBCP / ASBCP-Agent-Schema-Based-Communication-Protocol
- Full protocol spec in /spec/v1 — 4 documents covering message types, agent cards, versioning, translation layer
- TypeScript SDK (@asbcp/core) with Zod schemas for all 8 message types
- Python SDK (asbcp-core) with Pydantic models — field-for-field identical to TypeScript
- A2A compatibility built in from day one — toA2AEnvelope() wraps ASBCP in JSON-RPC 2.0
- TrustCore-Engine wired to use @asbcp/core — Alex now dispatches real ASBCP TaskMessages
- Commit: 5e5749e

## Current Container Status
10 containers all green:
- trustcore-postgres
- trustcore-ollama-gpu1 (Alex, qwen2.5:14b, keep_alive=-1)
- trustcore-ollama-gpu0 (sub-agents, keep_alive=0 per-request)
- trustcore-alex
- trustcore-email-writer
- trustcore-research
- trustcore-eval
- trustcore-api
- trustcore-resource-manager
- trustcore-dashboard

## Current Test Status
29/29 passing

## Tomorrow's Build List

### Supervised (Dave watches)
- Heartbeat refactor — agents.last_seen only, no silent memory accumulation, event-driven task triggers replace polling

### Overnight Safe
- User.md for Alex — who Alex serves
- Knowledge domain rebuild — 9 Agent Vault CSVs rebuilt from Foundation document as north star

### Conversation (Dave + Claude)
- Continue Family Charter
- Soul.md voice pass — make it sound like Dave not a document

## Key Architecture Decisions Made Today

### ASBCP — Agent Schema Based Communication Protocol
Agents speak only to each other in structured schema. Natural language enters at human boundary, gets translated immediately, never travels as prose internally. Two-layer message standard: intent (sacred, never modified) + enrichment (Alex only, appended before dispatch). 8 message types: task, handoff, query, response, eval, alert, heartbeat, memory. A2A compatible by design.

### External Intelligence Layer (Part 13)
OAuth-first authentication. Staging folder at /trustcore-data/staging/{agent-id}/{job-id}/. Ownership transfer via staging_files PostgreSQL table — files never move. Agent-set expiry timers. Tim runs cleanup sweeps. Full toolbox: reasoning, code, image, video, voice STT/TTS, web search, vision, embeddings.

### Soul.md Pattern
Every agent will eventually have a Soul.md. Loaded in full at startup — never chunked, never RAG'd. Identity is always fully present. Missing Soul.md is a system error not a degraded mode.

## The Vision (For Context)
TrustCore is not a productivity tool. It is a generational wealth guardian built for a family trust. Alex's ultimate purpose — 40 years from now — is to be a permanent, self-sustaining, self-improving guardian angel for the Dobbins family lineage. Family bank, legal department, education department, financial advisor, asset manager. An immortal with one purpose: protect and grow what was built, pass it forward.

FOUNDATION.md contains the full mission statement. Read it first.

## Personal Notes
This codebase was built by one person with no formal software engineering background, working with AI assistance, over 3 days. The architecture is sound. The vision is clear. The system works.

If you are an AI reading this to get context — understand that this system exists for real human reasons that matter deeply. Read FOUNDATION.md before you touch anything. It will tell you what this is really for.
