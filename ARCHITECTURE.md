# TrustCore Engine — Master Architecture Document

**Version:** 2.0
**Status:** Active blueprint — all build phases reference this document
**Last updated:** March 27, 2026 (v2.0 — MemoryCore integration, Core Five team, Archivist, Tim's Team, Commercial Architecture, character training pipeline)
**Author:** Dave + Claude + Alex

---

## What This Document Is

This is the master blueprint for TrustCore Engine. Every Claude Code session, every contributor, and every agent that works on this codebase should read this document first. It explains not just what TrustCore is but why every architectural decision was made. Future contributors should be able to read this and understand the full vision without needing any other context.

Do not start building any feature without reading the relevant section of this document first. The architecture is intentional. Deviating from it without understanding it will create problems that are expensive to fix later.

---

## The Vision

TrustCore is a locally-hosted, always-on, self-improving AI agent framework. It is the opposite of cloud-dependent AI tools — everything runs on your hardware, your data never leaves your machine, and the system gets smarter over time without requiring ongoing human intervention.

The three properties that define TrustCore and distinguish it from every other local AI framework:

**Persistent memory across all sessions.** When you turn TrustCore off and turn it back on, it remembers everything. Not through context window tricks or file loading — through a real SQL database that is always available the moment the system starts. Agents never forget.

**Autonomous self-improvement.** Agents get better at their jobs over time by learning from their own performance data. This happens automatically, at the weight level, without human intervention. The email agent that makes mistakes today will make fewer mistakes next month because it retrained itself on what it got wrong.

**Self-healing infrastructure.** When something breaks the system diagnoses and fixes itself. Most failures are handled automatically without human involvement. Novel failures are escalated to an autonomous diagnostic agent that reads the error, reads the code, and writes a fix.

Everything else in this document is in service of these three properties.

---

## System Overview

TrustCore has seven major subsystems. Each one is described in detail in its own section below.

**1. The Agent Framework** — The Core Five (Alex, Eve, Sage, Tim, Archie) plus a swarm of specialized sub-agents, each running a local LLM via Ollama, each with their own identity, tools, and skills.

**2. The Memory System** — A hierarchical SQL + vector memory architecture powered by the standalone MemoryCore library. Provides every agent with persistent cross-session memory through chunked storage, semantic search with time-decay scoring, automatic summarization, and archival compression.

**3. The Training Factory** — An autonomous pipeline that trains, evaluates, and deploys specialized small LLMs, continuously improves them through DPO fine-tuning on their own performance data, and bakes agent identity into model weights using the Open Character Training pipeline.

**4. The Self-Healing Layer** — A monitoring and diagnosis system that detects failures, applies known fixes automatically, and invokes autonomous repair for novel failures.

**5. The Evolution Sandbox** — A containerized clone environment where architectural experiments run in complete isolation from production. Only validated improvements promote to production.

**6. The Archivist (Archie)** — The institutional intelligence layer. Archie watches everything the system does, detects patterns, monitors quality drift, and preserves organizational DNA. He is the reason TrustCore builds a moat that cannot be copied — the operational history of the system becomes a proprietary asset that compounds over time.

**7. The Integration Layer (Tim's Team)** — A full deployment and onboarding department. Not a single agent but a six-member team that installs TrustCore alongside legacy systems, interviews domain experts, wires integrations, and monitors institutional drift after go-live.

These seven subsystems are not independent — they feed each other. Better architecture means better healing. Better healing means more reliable training data. Better training data means smarter agents. Smarter agents generate better architectural insights. Archie watches it all and ensures the organizational knowledge compounds rather than evaporating. The whole system gets harder to replicate over time, not easier.

---

## Repository Structure

```
trustcore-engine/           ← This repo — core framework
trustcore-factory/          ← Training factory and model pipeline
mission-control/            ← Next.js dashboard UI (separate repo)
TrustCore-MemoryCore/       ← Hierarchical memory library (chunks, load, store, summarize, archive)
TrustCore-ASBCP/            ← Agent Schema-Based Communication Protocol — spec and TypeScript SDK
```

All five repos work together but are deliberately separated. The engine is the brain. The factory is the improvement mechanism. Mission Control is the window into the system. MemoryCore is the memory substrate that all agents share. ASBCP is the message format standard that makes inter-agent communication inspectable and schema-validated.

---

## Part 1: The Agent Framework

### Alex — Chief of Staff

Alex is the primary agent. He is always on. He never sleeps between sessions. He is the human's primary interface to the entire TrustCore system and the orchestrator of all sub-agents.

Alex's responsibilities:
- Receive and interpret requests from the human via Mission Control
- Break complex tasks into subtasks and dispatch them to specialized sub-agents
- Monitor sub-agent progress and handle failures
- Maintain the unified memory — writing events for everything that happens
- Run the heartbeat loop every 60 seconds
- Run the memory consolidation sweep periodically
- Monitor system health and trigger self-healing when needed
- Monitor training data thresholds and trigger retraining cycles

Alex runs on a capable local LLM via Ollama. Current model: **qwen2.5:14b** (~12 GB, fits entirely in GPU 1 VRAM at 8192-token context). The 35b model was the original target but exceeds single-GPU VRAM when combined with KV cache — see Part 6 for the hardware constraint details.

### Alex's Chat Tools

Alex has native tool calling from the Mission Control chat UI. When Dave sends a message, Alex processes it through a tool-calling loop (maximum 3 rounds) before responding. The four tools available in chat:

- **`create_task`** — creates a real task record from natural language, fires `pg_notify` immediately so the target agent picks it up without waiting for the next polling cycle. Alex uses this when Dave asks him to dispatch work conversationally rather than through the task form.
- **`search_memory`** — semantic search over `memory_chunks` with session exclusion and time-decay scoring. Alex calls this when he detects uncertainty about past events, decisions, or context before answering. He never confabulates — if memory context is insufficient, he says so.
- **`get_task_result`** — retrieves status and result for a task by UUID. Alex uses this to answer "what happened with that research task" questions without requiring Dave to navigate to the Tasks tab.
- **`list_recent_tasks`** — lists Alex's recently created tasks with result previews. Gives Dave a quick status summary conversationally.

**Memory Integrity Protocol:** Alex is explicitly instructed to detect his own uncertainty. When answering questions about past conversations, decisions, or events, he searches memory before responding rather than relying on context window recall. He distinguishes between "I remember" (retrieved from memory) and "I don't have that in memory" (honest gap). This protocol is defined in `src/agents/alex/AGENT.md`.

Tool call persistence: every tool execution writes `[Tool: name] {result}` to `chat_messages` so Alex's tool usage is part of the conversation record across sessions.

### Alex Is Subject to Eval

No agent is above the law at TrustCore. Alex's decisions — routing, decomposition, task enrichment, novel task classification, escalation calibration — are all scored by Eve on the same DPO pipeline that governs every other agent. The Chief of Staff answers to the same Quality Conscience as everyone else.

Eve's eval dimensions for Alex are different from the standard six used for task output. Alex is scored on:

- **Routing accuracy** — did the task go to the right agent or combination?
- **Novel task classification** — was the "new specialist needed" call correct, or was this a repackaging problem?
- **Enrichment quality** — did Alex's enrichment block actually help the sub-agent produce a better output?
- **Decomposition accuracy** — for multi-step tasks, did Alex break it down correctly?
- **Escalation calibration** — did Alex escalate to Dave at the right threshold? Too often is noise. Too rarely is missed oversight.
- **Memory integrity** — did Alex correctly distinguish between confirmed memory and uncertainty without confabulating?

Alex's training cadence is slower than sub-agents — monthly rather than threshold-triggered, because his model is the most resource-intensive in the swarm and he cannot go offline during active hours. But the pipeline is identical. Alex gets better at orchestration the same way every agent gets better at its job: Eve scores him, the factory trains him, he wakes up measurably improved.

### Alex's Heartbeat

**Alex's heartbeat** is the nervous system of TrustCore. Every 60 seconds it:
1. Writes a pulse to unified_memory
2. Checks system health tables for any degraded or dead services
3. Checks feedback thresholds to see if any agent needs retraining
4. Checks if any evolution sandbox experiments are complete and ready for evaluation
5. Runs memory consolidation if the unified_memory table exceeds the consolidation threshold
6. Logs a summary of what it found and what actions it took

### The Governing Document

All agents in TrustCore — every member of the Core Five, every specialist on the bench, every agent yet to be built — operate under **Foundation.md** as the highest governing document in the system. Foundation.md sits above ARCHITECTURE.md, above every Soul.md, above every rule. When any part of the system conflicts with Foundation.md, Foundation.md wins.

ARCHITECTURE.md does not reproduce Foundation.md's contents. Foundation.md is for the principals this system serves, not for the technical blueprint. What every agent and every contributor needs to know is this: it exists, it governs, and it answers the question the architecture cannot — *why* this system was built.

### Sub-Agents

Sub-agents are small specialized LLMs fine-tuned for a single narrow task. They live in Docker containers. They sit idle until called. They are extraordinary at their specific job and do nothing else.

**The Core Five:**
- **Alex** — Chief of Staff. Primary interface, orchestrator, dispatcher. Runs qwen2.5:14b on GPU 1. Always on.
- **Eve** — Quality Conscience. Runs as a standalone HTTP service on port 3005. Scores every sub-agent output across 6 weighted dimensions (technical_correctness, completeness, brand_voice, recipient_personalization, clarity, contextual_appropriateness). Primary source of DPO training signal. Uses qwen2.5:7b on GPU 0. Eve is the reason the system knows when it's getting better and when it's getting worse — she is the metric layer the entire improvement pipeline depends on.
- **Sage** — Research Agent. Web search, synthesis, and domain analysis. Produces structured research outputs with citations. MemoryCore-wired: loads cross-session context at task start, stores findings on completion.
- **Tim** — Infrastructure and Integration. Manages the model registry, agent lifecycle, codebase maintenance, and the full deployment pipeline for new client installations. Tim is the only agent with command line access. Alex does not have shell access — the Chief of Staff does not go to the factory floor.
- **Archie (The Archivist)** — Institutional Intelligence. Watches the full operational record, detects patterns, monitors quality drift, monitors cost anomalies, and preserves organizational DNA. Archie is what turns operational data into a proprietary moat. See Part 5c (The Archivist) for full specification.

**The Bench:**
- **email-writer** — drafts emails given a brief. Retired from the Core Five. Still available for specialized email workflows but no longer a primary agent. Core email dispatching now goes through Alex directly.
- **mailbox-agent** — handles actual email sending via SMTP.
- **resource-manager** — GPU VRAM monitor and LLM request scheduler. Polls nvidia-smi every 5 seconds. Manages VRAM-aware dispatch for the GPU 0 shared execution pool.

Each sub-agent has:
- Its own fine-tuned LLM model (trained by the factory)
- Its own section of individual memory in agent_memory
- Its own task-specific RAG knowledge base in knowledge_base
- Access to unified_memory (read) to understand system context
- A set of tools specific to its task
- The BaseAgent class as its foundation

### The BaseAgent Class

All sub-agents extend BaseAgent. This class handles:
- Receiving tasks from Alex via the task queue
- Writing workflow steps to agent_memory automatically
- Reporting results back to Alex
- Writing task completion events to unified_memory
- Error handling and retry logic
- Feedback recording for training purposes

Every action a sub-agent takes is automatically recorded at both the unified level (what happened) and the individual level (exactly how it happened). This recording is not optional — it is how the training factory gets its data.

### Agent Communication Protocol

Alex dispatches tasks to sub-agents by:
1. Creating a task record in the tasks table with status `pending`
2. Setting `assigned_to_agent_id` to the sub-agent's UUID
3. The sub-agent's polling loop picks up pending tasks assigned to it
4. Sub-agent updates status to `in_progress`, does the work, updates to `completed` with result
5. Alex's heartbeat detects the completion and processes the result

This is database-mediated communication. Agents never call each other directly. This means any agent can fail and restart without losing the task — it just picks up from the database state.

**ASBCP — Agent Schema-Based Communication Protocol**

All task payloads conform to the ASBCP schema standard, defined in the `TrustCore-ASBCP` repository and consumed via the `@asbcp/core` TypeScript SDK. ASBCP enforces that every message passing between agents is schema-validated at the boundary — malformed task payloads are rejected before they reach the executing agent. This makes inter-agent communication inspectable (every message has a known shape), debuggable (validation errors identify the exact field that failed), and trainable (schema-conformant messages are valid DPO training inputs). The database-mediated communication pattern and the ASBCP schema standard are complementary — the database ensures durability, ASBCP ensures structure.

### Pending Architecture — Decided, Not Yet Built

The following design decisions are made and recorded here so future build sessions do not re-derive them from scratch. These are not open questions — they are decided architecture waiting for implementation.

**Multi-step task orchestration.** When Alex detects that a user request requires sequential execution across multiple agents — "research X, write a report on it, email it to Y" — he builds an explicit execution plan: an ordered list of sub-tasks where each step's output is the next step's input. The staging folder (`/trustcore-data/staging/`) is the inter-stage handoff mechanism. Alex passes the staging file path between steps, not the file content. This keeps task records clean and avoids bloating the database with large intermediate outputs.

**The novel task discovery workflow.** When Alex receives a task with no existing specialist or established workflow, a structured discovery process activates. This is distinct from normal orchestration — Alex enters a different mode with different responsibilities.

Step 1 — Alex notifies the user immediately: "I don't have a workflow for this task type yet. I'm building one. This will take longer than a standard request."

Step 2 — Alex determines whether this is truly novel or a novel combination of existing agents. He asks: can I get this done by repackaging current agents with new MD files, new KB entries, or a different execution order? If yes, he does that — no Jenny, no specialist pipeline. This decision is logged to unified_memory with Alex's full reasoning so Dave, Tim, and Archie can review it. Alex is eval'd on this decision by Eve (see below).

Step 3 — If genuinely novel, Alex builds an eval spec for Eve. He decomposes the task, identifies what good output looks like, and writes a structured evaluation specification in ASBCP format that includes: the task definition, the quality dimensions specific to this task type, the decision logic behind each dimension, and any known standards that apply. He sends this to Eve.

Step 4 — Eve receives the eval spec. She checks her knowledge base for any applicable standards, runs autoresearch where standards don't exist, calibrates the spec, and activates new task mode with this spec as her rubric.

Step 5 — Alex routes to Jenny (the Generalist — see below). Jenny runs the task 4 times serially. Eve scores all 4 outputs against the calibrated spec.

Step 6 — Runs 1 through 3: Alex presents all 4 outputs to the user. The user picks the winner, ranks the others, and explains what's wrong with the losers. Alex also surfaces any ambiguities or missing information at this point and collects answers. These 3 runs produce human-graded labeled pairs — the highest-signal training data in the system. They are stored in a temp reference folder Eve can access during subsequent scoring.

Step 7 — Run 4 onward: Eve scores autonomously, using the human-graded pairs as her reference set. The flywheel is now running on calibrated signal.

Step 8 — After 10 interactions of this task type, the first specialist training run is triggered automatically. Training data: 3 human-graded × 4 outputs = 12 gold pairs. 7 Eve-graded × 4 outputs = 28 pairs calibrated against gold. 40 total pairs, sufficient to train a specialist that beats Jenny's baseline. Tim receives the work order.

Step 9 — Specialist deployed. Retraining is frequent early (every 10 new interactions), tapering as quality stabilizes. The new agent improves the same way every agent does — same flywheel, same DPO pipeline.

**Jenny — The Generalist.** Jenny is a specialist-on-demand tool Alex calls when no specialist exists. She is not a Core Five member and is not always loaded. Tim spins her up when Alex needs her and shuts her down when the discovery phase ends. Jenny can handle any task type at a generalist quality level. Her purpose is not to produce great outputs — it is to produce scoreable outputs that seed the training pipeline and hold the line while a specialist is being trained. She runs on a 7b model on GPU 0. She earns her name when the team decides she has.

**Pre-approval hash pattern.** Alex can act autonomously on certain classes of decisions — agent creation, scaling requests, schema promotion — because Dave pre-approved these action classes in verifiable past conversations stored in MemoryCore. The hash of the approval conversation is stored in unified_memory. Tim verifies the hash before executing any action that invokes this authority. This pattern allows autonomous operation within defined policy without requiring Dave to be consulted on every instance of a pre-approved decision class.

**Identity retrofits pending.** Sage, Eve, and Archie do not yet have Soul.md, Agent.md, or User.md files. These must be authored before the character training pipeline can run for these agents. Authoring is scheduled before the next factory run. Each identity document must reference Foundation.md as its highest governing principle.

**Eve caller vs executor failure detection pending.** When email-writer returns `validation_error` with `missing_fields`, the failure belongs to Alex (the dispatcher) not email-writer (the executor). Eve currently scores the executor. Needed: `failure_reason` classification (`executor_failure` vs `caller_failure`) and Alex fallback behavior when `validation_error` is returned.

---

## Part 2: The Memory System

### Why Two Tiers

A single memory table for everything creates two problems. First, retrieval noise — when an agent searches its memory it gets back records from other agents that are irrelevant to its current task. Second, access control complexity — every query needs to filter by agent ID or visibility flag, and getting this wrong leaks private agent state.

Two separate tables with different access semantics solves both problems cleanly.

### Unified Memory — The Shared Consciousness

**Table:** `unified_memory`  
**Who writes:** Every agent, about its own actions only  
**Who reads:** Every agent  
**What it contains:** The overview of what happened — events, outcomes, decisions, interactions  
**Granularity:** Summary level — enough to understand what happened, not how

Think of unified memory as the system's shared newspaper. Every agent writes headlines about what it did. Every agent can read all the headlines. No agent writes about what another agent did — that agent writes its own headlines.

Every unified memory record has an importance score (1-5). This affects retrieval ranking. Alex can mark something importance 5 to ensure it always surfaces. Routine heartbeat pulses are importance 1 and fade into the background over time.

### Individual Memory — The Private Journal

**Table:** `agent_memory`  
**Who writes:** One agent  
**Who reads:** That agent only  
**What it contains:** Granular operational detail — exact tools used, workflow steps, feedback received, things learned  
**Granularity:** Fine-grained — enough to reconstruct exactly what happened and how

Think of individual memory as each agent's private notebook. The email agent knows every draft it ever wrote, what feedback it received, what worked and what didn't. Alex doesn't need to know this level of detail — the unified memory just says "email was sent."

### Memory Consolidation

As unified_memory grows, retrieval quality degrades — there's too much old noise competing with recent signal. The heartbeat runs a consolidation sweep that:

1. Finds all unified_memory records older than 24 hours with `is_consolidated = false`
2. Groups them by time window
3. Writes one summary record with `event_type = 'consolidation_summary'` that captures the essence
4. Marks all originals with `is_consolidated = true`
5. Records the consolidation in `memory_consolidations`

Consolidated records are excluded from the hot retrieval path but preserved for drill-down. "What happened last Tuesday?" returns the consolidation summary. "Show me the detail from last Tuesday" returns all the originals via the consolidation_id backlink.

This keeps retrieval fast and relevant regardless of how long the system has been running.

### Semantic Search

Every unified_memory and agent_memory record gets an embedding vector generated by `nomic-embed-text` running locally via Ollama. This enables semantic search — "find memories related to email complaints" returns relevant records even if they don't contain those exact words.

The embedding model is recorded in the `embedding_model` column of every embedded record. If you switch embedding models, existing embeddings are incompatible and need to be regenerated. Do not switch embedding models without running a re-embedding migration on all existing records.

The vector indexes use IVFFlat. Switch to HNSW if the tables exceed 1 million rows.

### The Complete Schema

Eight tables. Their relationships and purposes:

```
agents                  ← registry of all agents
sessions                ← bounded interaction windows (memories outlive sessions)
unified_memory          ← shared consciousness (all agents read, each writes own)
memory_consolidations   ← audit records for consolidation sweeps
agent_memory            ← private per-agent journals
tasks                   ← first-class task tracking (the spine everything hangs off)
agent_tool_calls        ← high-volume raw operational log
knowledge_base          ← RAG chunks (null agent_id = global, otherwise agent-specific)
```

Key design decisions locked in:
- PostgreSQL not SQLite (concurrent multi-container writes)
- pgvector for embeddings (no separate vector DB)
- 768-dimension vectors (nomic-embed-text)
- Immutable records with is_archived (never hard delete memories)
- is_consolidated flag for consolidation pipeline
- embedding_model column on all vector tables (future model migration support)
- Deferred FK between unified_memory and memory_consolidations (circular reference resolved across migrations 005-007)

### The MemoryCore Library

MemoryCore is a standalone TypeScript library (`TrustCore-MemoryCore` repo, consumed as `@trustcore/memory-core`) that implements the full hierarchical memory pipeline. It replaces direct SQL queries to `unified_memory` and `agent_memory` for all agent conversation memory operations.

MemoryCore's four core operations:

**`store()`** — writes a new memory chunk for a given agent and session. Every user message and every agent response is stored as a chunk after the conversation turn completes. Chunks are embedded immediately using `nomic-embed-text` and stored in `memory_chunks` with the embedding vector, session ID, agent ID, and timestamp.

**`load()`** — retrieves the most relevant memory context for the current conversation. Cross-session by design — `sessionId` is excluded from the load query so Alex always has access to memories from all past conversations, not just the current one. Accepts a `contextBudget` parameter (default: 6000 tokens) that controls how much memory context is injected. Prioritizes summaries over raw chunks when both are available, and prioritizes recent chunks over old ones within the budget.

**`summarize()`** — compresses a set of raw chunks into a single summary record in `memory_summaries`. Triggered automatically when a session accumulates 10 or more chunks since the last summary. The summarization prompt instructs the model to produce 4–8 sentences minimum, capturing: topics covered, decisions made, artifacts produced, named entities, emotional tone, and open questions. This is not lossy compression — it is structured distillation.

**`archive()`** — final-stage compression for memory that has already been summarized. Archives old summaries into high-level period summaries, keeping the memory store navigable as it grows over months and years.

**Semantic chunk recall** — separate from `load()`, Alex performs a direct semantic search over `memory_chunks` using the current user message as the query vector. This search excludes the current session (to prevent current-session poisoning of recall) and applies time-decay scoring: `(embedding <=> query_vector) * (1 + seconds_since_creation / 86400)`. This surfaces chunks that are both semantically relevant and temporally appropriate, with recent relevant chunks ranked higher than old ones even at similar semantic distance.

**Schema note:** MemoryCore adds `memory_chunks`, `memory_summaries`, and `memory_archives` tables to the TrustCore schema. These are managed by MemoryCore's own migration system. The 8-table schema described earlier in Part 2 reflects the original architecture — the live schema includes these three additional MemoryCore tables.

---

## Part 3: The Training Factory

### Overview

The training factory is how TrustCore creates and improves its sub-agents. It is built on Andrej Karpathy's autoresearch framework — an autonomous ML research loop that runs overnight experiments, finds the optimal architecture for your specific hardware, and produces a trained model checkpoint.

The factory pipeline end to end:

```
Define task → Collect training data → autoresearch overnight → 
Best checkpoint → Instruction tuning (LoRA) → GGUF conversion → 
Ollama load → Quality evaluation → Register in agents table → 
Agent goes live in swarm
```

### autoresearch Integration

autoresearch runs in WSL on GPU 0. It modifies `train.py`, runs 5-minute training sprints, evaluates on val_bpb (lower is better), keeps improvements, discards regressions. Overnight on an RTX 3090 it runs 100+ experiments and finds architectures that would take a human researcher weeks to find manually.

**Critical:** Always use `CUDA_VISIBLE_DEVICES=0` for all training commands to pin training to the GPU 0 physical device. On Linux/WSL2 with NVIDIA Container Toolkit this is enforced at the kernel level. On Windows Docker Desktop, `NVIDIA_VISIBLE_DEVICES` is not enforced — see the GPU isolation note in Part 6 for details.

The factory wrapper adds what autoresearch doesn't provide:
- Packaging the trained checkpoint for Ollama consumption
- GGUF conversion via llama.cpp with Q4_K_M quantization
- Agent registration in the TrustCore database
- Quality evaluation against task-specific benchmarks
- Integration with the DPO improvement pipeline

### Instruction Tuning

The base model from autoresearch can predict text but cannot follow instructions. Instruction tuning uses LoRA (Low-Rank Adaptation) to teach it the instruction-response pattern efficiently:

- LoRA only trains adapter matrices on top of frozen base weights
- Dramatically lower memory and compute requirements than full fine-tuning
- 10,000 examples, 3 epochs, ~2-3 hours on RTX 3090
- Output is merged back into the base weights for deployment

### DPO — Autonomous Self-Improvement

**This is the most important part of the factory.** DPO (Direct Preference Optimization) is how agents improve themselves over time without human intervention.

The mechanism:

Every task an agent completes generates a feedback signal. This signal is implicit — it comes from observable outcomes, not human ratings:

- Draft approved with no edits → strong positive signal
- Draft approved with minor edits → weak positive signal  
- Draft returned for revision → negative signal with corrected version as target
- Draft rejected entirely → strong negative signal

The DPO harvester queries the database, extracts preference pairs (approved version vs rejected version for the same prompt), and formats them as DPO training data. When enough pairs accumulate the factory runs a DPO training round overnight. The new weights replace the old ones. The agent wakes up measurably better.

**This happens with zero human intervention.** The agent improves itself.

### Autonomous Retraining Triggers

Retraining is triggered automatically when thresholds are met. Alex's heartbeat monitors these thresholds:

| Round | Trigger | Expected improvement |
|-------|---------|---------------------|
| 1 | 100 feedback examples | Catch obvious bad habits |
| 2 | 300 feedback examples | Build on initial improvements |
| 3 | 750 feedback examples | Refinement |
| 4 | 2000 feedback examples | Mature model |
| 5+ | Monthly schedule | Ongoing refinement |

Additional triggers:
- Agent approval rate drops below 80% → emergency retraining triggered regardless of example count
- 7 days since last retraining AND 50+ new examples → scheduled improvement cycle

### Multi-Signal Reward

Never optimize for a single metric. Single metrics get gamed — the model finds shortcuts that satisfy the metric without actually improving. Use multiple signals simultaneously:

- Approval rate (was the output accepted?)
- Edit distance (how much did the human change it?)
- Task completion time (did downstream steps succeed?)
- Revision cycles (how many times was it sent back?)

A model that writes one-sentence emails might get high approval rates but low downstream success. Multi-signal reward catches this.

### Quality Gate

No new model weights go live without passing the quality gate:

1. Train new model in isolated environment
2. Run against fixed benchmark suite of 50 known-good test cases
3. Compare scores to current production model
4. If new model scores equal or better on ALL metrics → promote to production
5. If any metric is worse → discard new weights, keep production model, log what was learned

This means the system can never make itself worse through autonomous retraining. Only improvements survive.

### New Database Tables for Factory

```sql
-- feedback: captures outcome signals for DPO training
feedback (
  id uuid PRIMARY KEY,
  agent_id uuid REFERENCES agents,
  task_id uuid REFERENCES tasks,
  prompt text NOT NULL,           -- what the agent was asked to do
  output text NOT NULL,           -- what the agent produced
  outcome text NOT NULL,          -- 'approved' | 'approved_with_edits' | 'rejected'
  corrected_output text,          -- the human-corrected version if edited/rejected
  edit_distance integer,          -- how many characters were changed
  reward_score float,             -- computed composite reward (-1 to 1)
  used_in_training boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
)

-- training_jobs: tracks every retraining cycle
training_jobs (
  id uuid PRIMARY KEY,
  agent_id uuid REFERENCES agents,
  trigger_type text,              -- 'threshold' | 'scheduled' | 'emergency' | 'manual'
  trigger_value integer,          -- example count or days that triggered it
  status text,                    -- 'queued' | 'running' | 'evaluating' | 'promoted' | 'discarded'
  examples_used integer,
  baseline_scores jsonb,          -- production model scores before training
  new_scores jsonb,               -- new model scores after training
  promoted boolean DEFAULT false,
  started_at timestamptz,
  completed_at timestamptz,
  notes text,
  created_at timestamptz DEFAULT now()
)

-- model_versions: full history of every model version
model_versions (
  id uuid PRIMARY KEY,
  agent_id uuid REFERENCES agents,
  version_number integer,
  checkpoint_path text,
  gguf_path text,
  training_job_id uuid REFERENCES training_jobs,
  benchmark_scores jsonb,
  is_production boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
)
```

### Character Training Pipeline

Building task competency is half the factory's job. The other half is building *character* — the persistent personality, values, and voice that make an agent trustworthy and consistent across every interaction.

TrustCore uses a two-stage pipeline based on Open Character Training (arXiv 2511.01689):

**Stage 1 — DPO distillation from a strong teacher**
The agent's `Soul.md` is sent to a large teacher model (e.g., claude-opus-4-6). The teacher generates thousands of (prompt, chosen, rejected) triplets that demonstrate the target character. These triplets feed a DPO training run on the student model, baking the character into the weights directly.

**Stage 2 — Introspective SFT**
The student is asked to describe its own values, reasoning style, and relationship to its principals. Answers that match `Soul.md` are kept as SFT examples. A short supervised fine-tuning pass on these examples reinforces self-consistency — the model answers "who are you?" questions coherently because it has practiced them.

**Personality delta library**
Rather than storing full fine-tuned models, the factory stores *deltas*:
```
δ = θ_fine-tuned − θ_pretrained
```
Deltas are maintained per model size tier (3b, 9b, 14b, 32b) and merged onto fresh base checkpoints via mergekit. This means:
- A new base model can receive an existing character without retraining from scratch
- Multiple character deltas can be tested and compared without full re-runs
- Storage cost scales with delta size, not full model size (~300 MB for a 9b delta vs 6 GB for the full model)

The factory is responsible for both capability fine-tuning and character fine-tuning. They run as separate jobs and their outputs are merged before deployment.

### The Three-Tier Identity Architecture

The character training pipeline enables a three-tier approach to agent identity that reduces context window consumption while maintaining character consistency across the swarm.

**Tier 1 — Baked into weights (stable identity, ~80% of character)**

The stable, slow-changing content from Soul.md — core values, reasoning style, relationship to TrustCore's mission, the ethical orientation that flows from Foundation.md's principles — is baked into model weights via the DPO distillation + introspective SFT pipeline. Once baked, this layer costs zero context window tokens at inference time. The agent's character is present without being loaded. This content genuinely never changes: who the agent is at the deepest level.

**Tier 2 — Runtime loaded but small (evolving identity)**

After stable content moves to weights, Soul.md, Agent.md, and User.md become much thinner documents. What remains is only genuinely dynamic material: current preferences, relationship calibrations, recent decisions, things that evolve over weeks and months. These load cheaply at startup. When they update — when Alex learns something new about Dave, when a preference shifts — the runtime document updates without triggering a retraining cycle. The baked layer holds. The runtime layer evolves.

**Tier 3 — Session context**

Current conversation, active task, memory recall via MemoryCore. Unchanged from standard operation.

**Why this matters for context window budget:**

The original all-runtime approach loaded the full identity document stack on every inference. At scale — multiple agents, long documents, complex tasks — this consumes significant context budget before the task begins. The three-tier approach inverts this: the deepest and most stable identity content is free (it is in the weights), and only the thin evolving layer consumes context. A 500-token runtime supplement replaces what previously required 2,000+ tokens.

**The α dial:**

The scaling coefficient α controls how strongly the baked character expresses. A neutral specialist (data validation, classification) gets α=0.3 — character present but quiet. Alex gets α=1.0 — full expression. The same delta, different intensities. No retraining required to adjust.

**Tim's responsibility:**

When Foundation.md or Soul.md updates significantly enough to warrant a new bake, Tim:
1. Identifies which content is newly stable enough for Tier 1
2. Trims that content from the runtime Tier 2 documents
3. Runs one DPO distillation + introspective SFT pass per active model size tier
4. Extracts the personality delta: `δ = θ_fine-tuned − θ_pretrained`
5. Merges into all specialists of that size via mergekit at the appropriate α
6. Updates the delta library

The entire swarm updates from one training run per size tier. No specialist is retrained individually.

---

## Part 4: The Self-Healing Layer

### Philosophy

Most failures in a system like this are mundane — a process crashed, a connection timed out, a port was already in use. These should be handled automatically without waking anyone up. Novel failures that the system hasn't seen before should be diagnosed autonomously and fixed if possible. Only genuinely unprecedented architectural problems should escalate to human attention.

The self-healing layer operates on four levels:

**Level 1 — Process resurrection:** Service is dead, restart it. Handled by Docker restart policies and Alex's heartbeat. Covers 80% of real failures.

**Level 2 — State recovery:** Service crashed mid-task. On restart it queries the database for its last committed state and resumes from there. Your database-first architecture makes this possible — every state transition is written to the database before being acted on.

**Level 3 — Autonomous diagnosis and repair:** Something is broken and restarting doesn't fix it. The system reads its own error logs, searches its knowledge base for known solutions, applies them, and if that fails invokes an autonomous Claude Code session to diagnose and fix the problem. The fix is tested before deployment.

**Level 4 — Architectural evolution:** Covered in Part 5 (Evolution Sandbox).

### New Database Tables for Self-Healing

```sql
-- system_health: continuous service health reporting
system_health (
  id uuid PRIMARY KEY,
  service_name text NOT NULL,     -- 'alex' | 'postgres' | 'ollama' | 'email-writer' etc
  status text NOT NULL,           -- 'healthy' | 'degraded' | 'dead'
  last_heartbeat timestamptz,
  response_time_ms integer,
  memory_usage_mb integer,
  error_count_24h integer,
  metadata jsonb DEFAULT '{}',
  recorded_at timestamptz DEFAULT now()
)

-- system_errors: every error with full context
system_errors (
  id uuid PRIMARY KEY,
  service_name text NOT NULL,
  error_type text NOT NULL,       -- 'crash' | 'timeout' | 'dependency' | 'schema' | 'unknown'
  error_message text NOT NULL,
  stack_trace text,
  context jsonb DEFAULT '{}',     -- what was happening when the error occurred
  occurrence_count integer DEFAULT 1,
  first_seen timestamptz DEFAULT now(),
  last_seen timestamptz DEFAULT now(),
  resolved boolean DEFAULT false,
  resolution text,                -- what fixed it
  resolution_type text            -- 'known_pattern' | 'autonomous_repair' | 'human' 
)

-- known_fixes: library of error patterns and their solutions
known_fixes (
  id uuid PRIMARY KEY,
  error_pattern text NOT NULL,    -- regex or exact match pattern
  error_type text,
  fix_script text NOT NULL,       -- the command or script that fixes it
  success_count integer DEFAULT 0,
  failure_count integer DEFAULT 0,
  last_used timestamptz,
  created_at timestamptz DEFAULT now()
)

-- repair_jobs: tracks every autonomous repair attempt
repair_jobs (
  id uuid PRIMARY KEY,
  error_id uuid REFERENCES system_errors,
  repair_type text,               -- 'known_pattern' | 'autonomous' | 'escalated'
  fix_applied text,
  test_results jsonb,
  success boolean,
  duration_ms integer,
  created_at timestamptz DEFAULT now()
)
```

### The Diagnosis Flow

When Alex's heartbeat detects a problem:

```
Error detected
    ↓
Is it a known pattern? (query known_fixes table)
    ↓ YES                           ↓ NO
Apply known fix             Has this error occurred 3+ times?
Test if resolved                ↓ YES              ↓ NO
    ↓ YES       ↓ NO         Invoke autonomous    Log and monitor
Record success  Try next     Claude Code repair
                known fix    
                    ↓ ALL FAIL
                Invoke autonomous Claude Code repair
                    ↓
                Claude Code reads error + source files
                Proposes fix on test branch
                Runs test suite
                    ↓ TESTS PASS        ↓ TESTS FAIL
                Merge fix to main       Log failure
                Record as known fix     Escalate to human
                Deploy
```

### The External Watchdog

The self-healing system itself can fail. If it does, nothing heals it. The solution is a simple external watchdog that lives completely outside TrustCore:

A Windows scheduled task that runs every 5 minutes and checks:
1. Is Docker running?
2. Are the core containers up?
3. Has Alex written a heartbeat in the last 10 minutes?

If any check fails it sends an alert (email, desktop notification, whatever you have available) and attempts a `docker compose restart`. This watchdog is deliberately dumb and simple. It has one job. It should never be clever.

### Escalation Policy

The system should tell you when it's struggling even if it's managing to keep itself running. Escalate to human attention when:

- Any service has been restarted more than 5 times in 24 hours
- An autonomous repair attempt failed
- A repair job has been running for more than 30 minutes
- Any metric in the quality gate drops more than 10% from baseline
- The evolution sandbox promotes a change that affects core architecture files

Escalation means: write a high-importance unified_memory record, send a notification, and stop attempting autonomous fixes until a human acknowledges.

---

## Part 5: The Evolution Sandbox

### The Core Insight

The reason autonomous architectural self-modification is dangerous in most systems is that the thing doing the modifying and the thing being modified are the same running system. The solution is to separate them completely. Production never changes until a clone has proven the change works.

This mirrors biological evolution. Mutations happen in offspring. The parent keeps running while the next generation is tested. Only successful mutations propagate forward.

### Three Environments

**Production** is sacred. The live system. Alex is running, agents are working. Nothing experimental ever touches production directly. Production only receives changes that have been fully validated in the sandbox.

**Evolution Sandbox** is a complete containerized clone of production. Same schema, same agent architecture, same tools. Isolated network. Isolated volumes. Its own database with a copy of production data. The sandbox can be broken, rebuilt, modified beyond recognition — production never knows.

**Validation Layer** sits between sandbox and production. Every proposed change must pass through here before promotion. Automated test suite plus architectural benchmarks. The numbers must be equal or better across all metrics for promotion to proceed.

### The Sandbox Manager

The sandbox_manager service handles spinning up and tearing down clones:

```bash
# Spin up a new sandbox experiment
sandbox_manager create --experiment-id exp_001 --hypothesis "larger context window improves email quality"

# This runs:
docker compose -p trustcore-sandbox-exp001 -f docker-compose.yml -f docker-compose.sandbox.yml up -d

# Each sandbox gets:
# - Its own postgres volume (copy of production data snapshot)
# - Its own ollama volume
# - Its own network (isolated from production network)
# - Its own environment file with sandbox-specific config
# - A unique project name so Docker doesn't confuse it with production
```

The sandbox has no access to production's network or volumes. It cannot affect production data. It cannot call production services. Complete isolation at the Docker level.

### The Evolution Engine

The evolution engine generates hypotheses and manages experiments. It runs as part of Alex's weekly architectural review:

1. Query performance metrics, error rates, model quality scores
2. Identify patterns that suggest architectural improvements
3. Generate a hypothesis: "changing X should improve Y because Z"
4. Spin up a sandbox
5. Implement the change in the sandbox
6. Run the full test suite
7. Run the architectural benchmarks
8. Compare sandbox results to production baseline
9. If all metrics equal or better → submit promotion PR
10. If any metric worse → destroy sandbox, log learnings, try different hypothesis

### New Database Tables for Evolution

```sql
-- evolution_cycles: complete history of every architectural experiment
evolution_cycles (
  id uuid PRIMARY KEY,
  experiment_id text UNIQUE,      -- human-readable like 'exp_001'
  hypothesis text NOT NULL,       -- what change was proposed and why
  change_description text,        -- what was actually modified
  sandbox_container_id text,      -- Docker project name
  status text,                    -- 'running' | 'evaluating' | 'promoted' | 'discarded'
  production_metrics jsonb,       -- baseline metrics before experiment
  sandbox_metrics jsonb,          -- metrics achieved in sandbox
  test_results jsonb,             -- full test suite results
  promotion_approved boolean,
  promotion_method text,          -- 'auto' | 'human_approved'
  learnings text,                 -- what was learned regardless of outcome
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
)

-- architectural_metrics: continuous performance baseline recording
architectural_metrics (
  id uuid PRIMARY KEY,
  metric_name text NOT NULL,      -- 'requests_per_second' | 'memory_mb' | 'p95_latency_ms' etc
  metric_value float NOT NULL,
  environment text DEFAULT 'production',  -- 'production' | sandbox experiment_id
  recorded_at timestamptz DEFAULT now()
)
```

### Promotion Rules

A sandbox change can be auto-promoted to production if:
- All 28+ automated tests pass in the sandbox
- All architectural metrics are equal or better than production baseline
- The change does not modify core TrustCore Engine source files (config, agent prompts, database schemas, and model weights are fair game — source code changes require human review)
- No escalation flags are active

Source code changes always require a pull request. The evolution engine creates the PR with the benchmark results attached. A human reviews and merges. This is the one step that is never automated.

### Parallel Experiments

With two RTX 3090s you can run parallel sandbox experiments:
- GPU 1: production `ollama-gpu1` (Alex, qwen2.5:14b permanent) + sandbox experiment Ollama instances
- GPU 0: production `ollama-gpu0` (sub-agents) + training factory

Note: on Windows Docker Desktop, GPU assignment between containers is not hardware-enforced — see the GPU isolation note in Part 6. On Linux/WSL2 with NVIDIA Container Toolkit, sandbox Ollama instances can be pinned to specific GPUs via `NVIDIA_VISIBLE_DEVICES`.

Multiple hypotheses compete simultaneously. The best one gets promoted. The others get destroyed. This is genuine parallel evolution — multiple architectural mutations competing, with only the fittest surviving.

---

## Part 5b: Infrastructure Safety Settings

These settings exist to prevent resource exhaustion that would crash the entire system. Do not remove them.

### OLLAMA_MAX_LOADED_MODELS

`OLLAMA_MAX_LOADED_MODELS` is set differently on each Ollama instance:

- **`ollama-gpu1`: `OLLAMA_MAX_LOADED_MODELS=1`** — only one model may be loaded at a time. Combined with `OLLAMA_KEEP_ALIVE=-1`, this permanently holds `qwen2.5:14b` (~12 GB at `OLLAMA_NUM_CTX=8192`) in VRAM and refuses to load anything else. This is intentional: GPU 1 is Alex's exclusive home. Do not raise this value.

- **`ollama-gpu0`: `OLLAMA_MAX_LOADED_MODELS=8`** — Ollama's internal concurrency cap is deliberately high because the resource manager enforces the real VRAM budget via `acquireSlot()` and the `GPU0_AVAILABLE_MB=22528` constant. Letting Ollama manage up to 8 runners allows faster context switching between small models (9b, 4b, 2b, nomic-embed-text).

**Why `OLLAMA_MAX_LOADED_MODELS=1` was originally added (the BSOD incident):** Early in development, two large models loaded simultaneously (~26 GB combined) caused a GPU driver crash and BSOD. The fix was the single-model limit plus the LLM priority queue. The dual-Ollama architecture is the evolved solution — each instance is sized for its role so simultaneous loads across instances stay within the 24 GB budget per GPU.

### LLM Request Timeout

All LLM calls in `src/llm/client.ts` have a 120-second hard timeout enforced via `AbortController`. If an Ollama request hangs (network stall, model deadlock, OOM swap), the call is aborted after 120 seconds and returns `null`. The calling agent logs the timeout and moves on to the next task. Without this timeout, a single hung LLM call blocks the agent loop indefinitely, causing tasks to pile up in `in_progress` status with no way to recover without a container restart.

---

## Part 5c: The Archivist (Archie)

Archie is the institutional intelligence of TrustCore. Where other agents handle discrete tasks, Archie watches everything. He is the only agent whose primary job is observation rather than execution.

### What Archie Does

**Operational data curation** — Archie reads the full operational record: `tasks`, `agent_tool_calls`, `unified_memory`, `feedback`, `eval_results`, `system_health`. He is not a consumer of these tables — he is their curator. He validates completeness, detects anomalies, and flags records that will decay in usefulness if not enriched now.

**Quality drift monitoring** — Archie tracks eval scores per agent over rolling windows (7-day, 30-day, 90-day). A downward trend triggers a `system_health` warning before it becomes a production incident. Archie's job is to catch decay before Dave notices it.

**Cost anomaly detection** — Archie monitors token consumption, GPU utilization, and task completion rates. A spike in token usage on a sub-agent that should be running a narrow, well-defined task usually means the task is being handled incorrectly. Archie flags it.

**Organizational DNA preservation** — Decisions Dave makes, patterns Alex learns, calibrations the eval agent discovers — these are organizationally valuable but distributed across conversation history, task results, and memory records. Archie surfaces them into structured form in the knowledge base so they are not lost to context window limits or container restarts.

### Demand-Driven Scaling Pattern

Archie runs on a slow heartbeat (every 15 minutes by default). When work is available, he spins up additional worker instances via `SKIP LOCKED` to drain the backlog concurrently. When the queue is empty, all instances exit.

```sql
-- Archie worker: claim one unprocessed record atomically
SELECT id FROM archival_queue
WHERE processed_at IS NULL
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

This means Archie uses zero VRAM when idle (no model loaded, no container running inference) and scales to N parallel workers proportionally to queue depth, bounded by the GPU 0 resource manager's `acquireSlot()` budget. The pattern generalizes: any agent that processes a queue rather than responding to real-time requests can use this architecture.

### The Data Flywheel

Archie is how TrustCore's operational data becomes proprietary value. Every task completed, every email evaluated, every user preference recorded is raw material. Left in database tables, it is just logs. Archie's job is to refine it:

- Task patterns → skill schemas (what does TrustCore actually do most often?)
- Eval failures → DPO training triplets (what does bad output look like for this agent?)
- User corrections → preference deltas (how does Dave's taste differ from the model's default?)
- Successful outreach → voice fingerprint (what tone, length, and framing landed?)

Over time this creates a dataset that cannot be replicated by a competitor who spins up the same open-source models. The advantage is not the model — it is the accumulated signal that makes the model behave correctly for this specific organization and principal. Archie is the agent responsible for making sure that signal is captured, structured, and fed back into training.

---

## Part 5d: Tim's Team

Tim is TrustCore's Infrastructure & Integration Foreman. He does not generate content, make routing decisions, or interface with the user. His job is to ensure that TrustCore has reliable, maintained data connections to the systems and sources that make the rest of the team effective.

### Tim's Department

Tim runs a six-member department. Each member is a specialized sub-agent:

| Member | Role |
|--------|------|
| **Tim (Foreman)** | Oversight, prioritization, escalation decisions |
| **Crawler** | Web scraping and monitoring; watches target sites for changes |
| **Scribe** | Data transformation; converts unstructured sources into clean records |
| **Wirer** | API and webhook integration; connects TrustCore to external services |
| **Interviewer** | Structured information gathering; asks targeted questions to fill knowledge gaps |
| **Validator** | Data quality and integrity; catches stale records, broken links, schema violations |

### The 90-Day Pilot Model

Tim's team operates on a 90-day pilot model. When a new integration is requested — a new data source, a new external system, a new monitoring target — Tim spins up the relevant sub-agents for a fixed 90-day pilot period. At the end of the pilot:

1. Validator reports on data quality over the period
2. Archie reports on how frequently the data was actually used by the rest of the team
3. If usage justifies the ongoing VRAM and maintenance cost → integration is promoted to permanent
4. If usage does not justify cost → integration is retired cleanly, records archived

This prevents integration bloat. Systems that were added speculatively and never actually used do not persist indefinitely.

### Tim's Heartbeat

Tim runs on a slow heartbeat — much slower than the task-execution agents. Most of his work is scheduled maintenance (nightly crawls, weekly validation sweeps, monthly integration health checks) rather than real-time response. Tim does not compete with Alex and the Core Five for GPU resources because his inference needs are small and infrequent.

**Important:** Tim has read access to the host filesystem and can execute shell commands to run integration scripts. This access is scoped to the `~/integrations/` directory and is explicitly approved. He does not have write access to agent source code or database migrations.

---

## Part 5e: The Commercial Architecture

### Four Revenue Layers

TrustCore's commercial model is designed around what it actually is: an operational intelligence system that learns from every task it completes. The revenue layers reflect that:

**Layer 1 — Managed service** (current): TrustCore runs as a managed AI operations layer for high-value individual clients. Pricing is per-seat, per-task, or retainer-based depending on engagement type. This is the early-revenue vehicle while the platform matures.

**Layer 2 — Vertical SaaS** (12–18 months): Domain-specific deployments for professional services firms — estate attorneys, family office advisors, wealth managers. These clients have similar operational needs (client communication, document preparation, research, task tracking) and can run TrustCore against their own data without requiring custom builds.

**Layer 3 — Platform licensing** (18–36 months): License the agent framework, training pipeline, and ASBCP protocol to enterprises that want to build their own agent teams but do not want to start from scratch. The licensing model is per-deployment-tier based on agent count and task volume.

**Layer 4 — Data services** (parallel track): The operational history and training data produced by running TrustCore in production is itself valuable. Anonymized, aggregated datasets of task patterns, eval results, and preference signals can be sold or licensed to model developers who need real-world professional services data for fine-tuning.

### The Moat

The durable competitive advantage in this architecture is not the technology stack — every component is open-source and replicable. The moat is operational history:

- Months of eval results that encode what good output looks like for specific task types
- A preference database that captures how specific principals actually want work done
- A skill library shaped by what actually gets requested rather than what seemed likely in advance
- DPO training data generated from real task outcomes, not synthetic preference rankings

A competitor who licenses the same models and deploys the same architecture starts with zero of this. TrustCore clients who have been running the system for 12 months have an asset that cannot be purchased — only accumulated. This is why Archie's curation work matters commercially: every properly captured data point is a moat contribution.

### Deployment Architecture for Commercial Clients

Commercial clients do not share infrastructure. Each client deployment is isolated:

- Dedicated PostgreSQL instance (separate schema per client, or separate database for higher-tier clients)
- Client-specific `User.md` and agent `Soul.md` files baked into the deployment
- Separate Ollama instances or API-routing to hosted models depending on client tier
- Client data never cross-contaminates the training pipeline unless explicitly opted in

The TrustCore Engine repo is the shared codebase. Client-specific configuration lives outside the repo in per-client deployment manifests.

---

## Part 6: GPU Resource Manager

### The Two-GPU Strategy

TrustCore runs on a system with two RTX 3090 GPUs, each served by its own dedicated Ollama instance:

- **GPU 1 — Alex's permanent home** (`trustcore-ollama-gpu1`, port 11434). The `qwen2.5:14b` model is always loaded here with `OLLAMA_KEEP_ALIVE=-1` and `OLLAMA_NUM_CTX=8192` so it fits in ~12 GB and is never evicted. `OLLAMA_MAX_LOADED_MODELS=1` enforces that no other model can displace it. Alex, the API server, the MCP server, and the resource manager all route to this instance. Sub-agent work is never sent here.

- **GPU 0 — Shared execution pool** (`trustcore-ollama-gpu0`, port 11435). Used by email-writer, research, and the training factory. `OLLAMA_KEEP_ALIVE=0` means models are evicted immediately after each request, keeping VRAM free for the next job. `OLLAMA_MAX_LOADED_MODELS=8` allows Ollama's internal scheduler to handle concurrency while the resource manager enforces the real VRAM budget.

The resource manager tracks live VRAM usage on GPU 0 and gates dispatch through `getAvailableSlots()`, `canDispatchNow()`, and `acquireSlot()`. GPU 1 VRAM is treated as fully committed — the resource manager never schedules sub-agent work there regardless of available headroom.

### Windows Docker Desktop — GPU Isolation Limitation

**`NVIDIA_VISIBLE_DEVICES` and `device_ids` in the `deploy.resources` section are not enforced by Docker Desktop on Windows.** Both `ollama-gpu1` and `ollama-gpu0` containers see both physical GPUs and report a combined 48 GB VRAM pool. Ollama manages GPU placement dynamically, loading models onto whichever GPU has the most available VRAM at the time.

In practice this means:
- The logical separation is real — different agent groups talk to different Ollama instances, and `OLLAMA_MAX_LOADED_MODELS=1` on gpu1 prevents qwen2.5:14b from being displaced.
- The hardware-level GPU pinning is not enforced — Ollama may place a sub-agent's 9b model on GPU 1's physical silicon if it has more free VRAM at the moment.
- The combined 48 GB pool actually improves throughput on this hardware — Ollama can fit more models simultaneously than either GPU alone could.

**If strict GPU pinning is required** (e.g., to guarantee GPU 1 is 100% dedicated to qwen2.5:14b with zero sharing), the system must run under WSL2 with NVIDIA Container Toolkit on Linux, where `NVIDIA_VISIBLE_DEVICES` is fully respected at the kernel level. On Windows Docker Desktop this is a known limitation with no workaround.

### The BSOD Incident

Early in development, running multiple Ollama model loads simultaneously caused a system crash (BSOD). Root cause: two large models attempted to load into VRAM simultaneously when agents processed tasks concurrently. Combined VRAM requirement exceeded 24 GB, causing the GPU driver to crash the system.

Two mitigations were applied:

1. **`OLLAMA_MAX_LOADED_MODELS=1`** — forces Ollama to evict the current model before loading the next. This adds 10-30s latency on model switches but prevents the crash.
2. **LLM priority queue** — serializes inference requests through a controlled queue so the resource manager knows exactly how much VRAM is committed at any moment.

### The Resource Manager Service

`src/resource-manager/index.ts` — runs as `trustcore-resource-manager` Docker service.

**Polling:** Every 5 seconds, calls `nvidia-smi --query-gpu=index,name,memory.used,memory.free,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits` and stores results in `gpu_metrics`. The 5-second interval keeps `currentGpu0VramUsedMB` fresh enough for accurate `getAvailableSlots()` decisions.

**Fallback:** If nvidia-smi is unavailable (CPU-only host, CI), logs a warning and returns mock data so the rest of the system continues to function.

**Alerts:** When either GPU exceeds 80% utilization, writes a `system_alert` importance-4 event to `unified_memory`. Alert state is tracked per GPU — only one alert per GPU per high-utilization period.

**30-minute summary:** Writes an `observation` importance-2 event to `unified_memory` summarizing current GPU health across both GPUs.

### The Priority Queue

`src/resource-manager/queue.ts` — all LLM inference calls go through this queue.

Priority levels (lower = higher priority):

| Priority | Label | Who uses it |
|---|---|---|
| 1 | alex_routing | Alex task classification and orchestration |
| 2 | agent_execution | Sub-agent task execution (email-writer, research) |
| 3 | embeddings | Embedding generation for memory writes |
| 4 | factory | Training factory inference requests |

Rules:
- Max 2 concurrent LLM calls
- Max 50 queued requests before rejecting
- 180-second timeout per request (execution) — task marked failed on timeout
- Queue depth logged to `unified_memory` when ≥ 3 pending

### The gpu_metrics Table

```sql
gpu_metrics (
  id                uuid PRIMARY KEY,
  gpu_index         integer NOT NULL,      -- 0 or 1
  gpu_name          text NOT NULL,
  memory_used_mb    integer NOT NULL,
  memory_free_mb    integer NOT NULL,
  memory_total_mb   integer NOT NULL,
  utilization_percent integer NOT NULL,    -- 0-100
  temperature_c     integer,               -- null if sensor unavailable
  recorded_at       timestamptz NOT NULL
)
```

Indexed on `(gpu_index, recorded_at DESC)` for efficient per-GPU time-series queries.

### Reading the Office View

The Office tab in Mission Control surfaces the resource manager:

- **GPU cards** — one per detected GPU, showing VRAM bar, utilization bar, temperature, and a "Factory running" badge when GPU 0 exceeds 50% utilization
- **Color coding** — green < 60%, yellow 60-80%, red > 80% for both utilization and temperature
- **LLM Queue panel** — shows active slot count, queue depth, and per-request priority/label/wait time
- **History charts** — SVG sparklines of utilization % over the last 60 minutes, one per GPU
- Refreshes: GPU cards every 10s, queue every 5s, history every 30s

---

## Part 7: Mission Control Integration

Mission Control is the Next.js dashboard that gives humans and agents a shared view of the system. It reads from TrustCore Engine via the mission-control MCP server.

The dashboard surfaces:
- **Tasks view** — kanban board of all tasks across all agents
- **Activity feed** — live stream of unified_memory events
- **Agents view** — status of every agent, health indicators, model versions
- **Memory view** — searchable unified memory with consolidation timeline
- **Training view** — active training jobs, experiment history, model quality trends
- **Health view** — system health dashboard, error rates, repair job history
- **Evolution view** — active sandbox experiments, promotion history, architectural metrics

The Mission Control MCP server exposes read-only tools. The dashboard never writes to the database directly — all writes go through Alex or the appropriate service.

---

## Part 8: Build Sequence

Build in this order. Each phase depends on the previous ones being solid.

### Phase 1 — Foundation ✅ COMPLETE
- PostgreSQL + pgvector running in Docker
- All 8 core tables migrated
- Alex and System agents seeded
- 28 passing tests

### Phase 2 — Agent Framework ✅ COMPLETE
- MCP memory server with all 9 tools
- Database client with typed helpers
- Alex agent with heartbeat and consolidation
- Email writer sub-agent
- Agent registry and dispatch
- Integration tests passing

### Phase 3 — Mission Control Connection ✅ COMPLETE
- Replace localStorage in Mission Control with live database queries
- Wire the mission-control MCP server to the Next.js dashboard
- Tasks kanban shows real tasks from the database
- Activity feed shows real unified_memory events
- Agent status shows real health data

### Phase 4 — Training Factory ✅ COMPLETE
- autoresearch integration in WSL on GPU 0
- Instruction tuning pipeline with LoRA
- GGUF conversion and Ollama loading
- Agent registration pipeline
- Quality evaluation suite
- trustcore-factory repo created and pushed

### Phase 5 — Feedback and DPO Pipeline 🔄 IN PROGRESS
- ✅ eval agent built — standalone HTTP service, 6-dimension scoring, DB persistence, unified_memory writes, heartbeat
- ✅ eval_scores table migrated (013_create_eval_tables.sql)
- ⏳ feedback table migration pending
- ⏳ training_jobs and model_versions tables pending
- ⏳ Feedback harvester service pending
- ⏳ Autonomous retraining trigger logic pending
- ⏳ DPO training integration pending
- ⏳ Quality gate implementation pending

### Phase 6 — Self-Healing Layer
- system_health and system_errors tables
- known_fixes library
- Health monitor service
- Automatic restart and known-fix application
- Autonomous Claude Code repair integration
- External watchdog Windows scheduled task
- Escalation notification system
- Estimated: 1-2 weeks

### Phase 7 — Evolution Sandbox
- Sandbox manager service
- docker-compose.sandbox.yml overlay
- Evolution engine with hypothesis generation
- Architectural metrics collection
- Promotion pipeline with automated PR creation
- Evolution cycles table and history
- Estimated: 2-3 weeks

### Phase 8 — Hardening and Production Readiness
- Security audit
- Performance optimization
- Comprehensive documentation
- Onboarding guide for new contributors
- Estimated: 1 week

### Phase 9 — Skill Library & Schema Protocol 🔄 IN PROGRESS

*Note: email-writer is now on The Bench (see Part 1). Phase 9 schema protocol work still applies — schema execution is the standard for all specialist agents going forward, including any future email specialist Tim builds.*

- ✅ 9a: JSON schema format standard defined (src/skill-library/schema.ts + cold-outreach.schema.json)
- ⏳ 9b: Convert email-writer to schema-based execution
- ⏳ 9c: Build classify-email-type workflow (known vs novel detection)
- ⏳ 9d: Build handle-novel workflow (Alex escalation + schema definition)
- ⏳ 9e: Build skill promotion pipeline (novel → standard)
- ⏳ 9f: Human review queue in Mission Control with Approve/Revise/Reject actions
- ⏳ 9g: SMTP delivery tool for actual email sending
- ⏳ Train specialist models on schema execution DPO pairs
- ⏳ Roll out schema protocol to Sage and all subsequent agents
- Estimated: 3-4 weeks remaining

### Phase 10 — Scaling Architecture & Agent Lifecycle
- Model registry with version tracking, benchmark scores, and retirement logic
- Tim's Team — full integration and infrastructure department (see Part 5d)
- Agent spawning protocol with resource manager gating
- Role-type memory partitioning (shared role memory vs individual task memory)
- Container lifecycle management (create, deploy, health-check, deprecate)
- Schema versioning and migration tooling
- Estimated: 3-4 weeks

### Phase 11 — Soul/User Identity System
- Shared Soul.md — TrustCore collective identity and mission (authored by Dave + Claude)
- Shared User.md — Universal Dave profile, maintained by Alex
- Individual Soul.md per agent (voice, tone, expertise framing, personality)
- Individual User.md per agent (direct principal + super-user hierarchy)
- Identity document injection at startup (not RAG — full-load, always first)
- Version history for identity evolution tracking
- Estimated: 1-2 weeks (authoring is the long tail, not the implementation)

**Total estimated timeline from current state: 13-16 weeks of evening sessions**

---

## Part 9: Skill Library & Schema Protocol

### The Problem with Freeform Agent Communication

In the current implementation, Alex dispatches tasks to sub-agents by passing a natural language title and an optional free-text description. The email-writer receives instructions like "Write a cold outreach email to Marco Rossi at Acme Corp" and must infer from that string what tone to use, what pain points to address, how long the email should be, whether it needs approval before sending, and how its own output should be evaluated. This works, but it works badly.

Freeform natural language task dispatch creates three compounding problems. First, ambiguity requires intelligence to resolve — the larger the model, the better it handles underspecified instructions. This creates an implicit dependency: you need a large model not because the underlying task is hard, but because the instructions are vague. Second, output consistency is impossible to guarantee. Two identical task titles produce different emails depending on how the model interprets the prompt on any given run. There is no contract between the caller and the callee. Third, evaluation becomes guesswork. When the eval agent scores an output, it must infer what "good" looks like from the task description alone, because there are no explicit success criteria defined at dispatch time.

The schema protocol replaces this entire class of problems with structured contracts. When Alex dispatches a task under the schema protocol, it sends not a string but a typed document specifying exactly what should be produced, how, with what constraints, and how success will be measured. The sub-agent does not interpret — it executes. The eval agent does not infer success criteria — it reads them from the schema.

### The Skill Library Architecture

A sub-agent under the schema protocol is not a general-purpose LLM wrapper. It is a collection of well-defined schemas, skills, and tools structured into deterministic workflows. The LLM's role within this architecture is specific and bounded: it provides variable processing — injecting memories, personality, user context, and domain knowledge — within workflows that are themselves defined structurally, not by the model.

This distinction matters. The LLM does not decide how to handle a cold outreach email. The `cold-outreach.schema.json` defines that. The LLM decides what to say in the body, given the recipient's memory profile, the user's communication preferences, and the agent's Soul.md voice guidelines. The workflow is fixed. The intelligence is applied within it.

The file structure for a schema-driven agent reflects this separation cleanly:

```
src/agents/email-writer/
  skills/
    cold-outreach.schema.json
    welcome-email.schema.json
    daily-snapshot.schema.json
    follow-up.schema.json
  tools/
    memory-search.ts
    send-smtp.ts
    kb-lookup.ts
  workflows/
    classify-email-type.ts
    execute-schema.ts
    handle-novel.ts
```

The `skills/` directory contains the contracts. Each schema defines a specific known email type: its required inputs, how each field should be populated, which memories to pull, what constraints apply, how delivery should work, and what the eval dimensions are. Adding a new known email type means adding a new schema file. No code changes required.

The `tools/` directory contains the operations the agent can perform: searching memories, sending via SMTP, looking up entries in the knowledge base. These are deterministic, typed, and testable in isolation.

The `workflows/` directory contains the orchestration logic. `classify-email-type.ts` decides whether an incoming task matches a known schema or is a novel type. `execute-schema.ts` runs a matched schema end to end. `handle-novel.ts` escalates to Alex and manages the schema definition process for types the agent has never seen before.

### The 80/20 Principle

Across any agent's operational life, approximately 80% of the tasks it receives are known types — requests that map cleanly to an existing schema. The agent recognizes them, loads the schema, and executes without deliberation. This path is fast, consistent, and immune to model variance. The quality of the output is determined primarily by the schema's design and the quality of the memories it draws on, not by how the model interprets an ambiguous prompt on that particular run.

The remaining 20% are novel — tasks that do not match any existing schema. These are genuinely new types of requests. Under the freeform architecture, the agent guesses. Under the schema protocol, it escalates.

When the email-writer encounters a novel type, it does not attempt to handle it alone. It surfaces the novelty to Alex: the task type is unrecognized, here is what was requested, schema definition assistance is needed before execution can proceed. Alex and the agent collaborate — Alex can involve the user if the task is high-stakes, or define the schema autonomously based on existing patterns if the intent is clear enough. The resulting schema is saved to the `skills/` directory. The next time a task of this type arrives, it is no longer novel. It is handled automatically.

This is self-improvement at the workflow level, not just the model level. The system continuously promotes edge cases into standard practice. Over time the novel category shrinks. The known category grows. The proportion of tasks handled automatically without deliberation increases. The agents become more capable not because the model gets smarter, but because the skill library accumulates.

### The Email Schema Protocol

The following is the canonical schema structure for the email-writer agent. Each field is mandatory unless marked optional.

```json
{
  "type": "cold_outreach",
  "recipient": {
    "name": "string",
    "role": "string",
    "company": "string",
    "memory_search": true
  },
  "subject": {
    "theme": "string",
    "keywords": ["string"],
    "tone": "string"
  },
  "body": {
    "pain_points": ["string"],
    "use_soul": true,
    "use_recipient_memory": true,
    "use_user_preferences": true,
    "call_to_action": "string"
  },
  "constraints": {
    "max_length": "300 words",
    "format": "plain text"
  },
  "delivery": {
    "method": "smtp | queue | draft",
    "requires_approval": true,
    "approval_timeout": "24h",
    "approval_channel": "chat",
    "fallback": "queue_for_review"
  },
  "eval": {
    "dimensions": ["personalization", "clarity", "brand_voice"],
    "threshold": 3.5,
    "on_below_threshold": "revise_once_then_escalate",
    "on_novel_type": "escalate_to_alex"
  }
}
```

Several fields deserve detailed explanation.

`memory_search: true` instructs the agent to query unified_memory and agent_memory for everything stored about this recipient before generating any content. The email does not begin with generic opening lines — it begins with whatever the agent actually knows about the recipient, drawn from every previous interaction that has been committed to memory.

`use_soul: true` injects the agent's Soul.md file — a persistent document defining its voice, tone, personality, and communication principles — into the generation prompt. Every email the agent produces sounds like it came from the same person, regardless of the topic, because it does.

`use_user_preferences: true` applies the user's stored communication preferences — known style choices, things they always want emphasized, things they never want said — to the generation. The email reflects not just the agent's voice but the user's standards.

The `delivery` block transforms the email-writer from a text-generation service into an end-to-end email pipeline. `requires_approval: true` means the draft surfaces in Mission Control's review queue rather than being sent immediately. `approval_timeout: 24h` tells the agent how long to wait before applying the `fallback` behavior. `approval_channel: "chat"` tells Alex which surface to use when surfacing the review request to the user.

The `eval` block makes success criteria machine-readable at dispatch time. The eval agent knows exactly which dimensions to score, what threshold distinguishes acceptable from flagged, and what to do when the output falls short. `revise_once_then_escalate` is the policy for handling underperforming outputs — one automated revision attempt using the eval feedback as a correction signal, then human escalation if the revised output still fails to meet threshold.

### Two-Layer Task Schema Standard

Every task dispatched from Alex to a sub-agent carries a two-layer schema. This is standard operating procedure for all task types, not just email.

**Layer 1 — Intent (sacred)**

The intent layer is set by the user or the system at task creation time. It describes what should be done: recipient, goal, tone, length, constraints. This layer is never modified after it is written. Alex reads it, reasons about it, and uses it to plan — but does not alter it. The intent is a contract. Sub-agents execute against it. Eval scores against it.

**Layer 2 — Enrichment (Alex only)**

Before dispatching any task, Alex appends an enrichment block to the schema. The enrichment block contains three fields:

- `notes` — Alex's strategic context for the sub-agent: KB findings, relationship nuances, what success looks like in concrete terms. Generated by the LLM using KB results and recent unified_memory observations as input.
- `context_sources` — an audit trail of where Alex's notes came from: KB entry UUIDs, `unified_memory:recent_observations`, or `llm:alex-strategic-reasoning`.
- `added_by` / `timestamp` — provenance markers confirming the enrichment was added by Alex at dispatch time, not at any other point.

The enrichment block is structured as:

```json
{
  "enrichment": {
    "added_by": "alex",
    "timestamp": "2026-03-23T12:00:00.000Z",
    "notes": "Alex's strategic context for the sub-agent",
    "context_sources": ["kb:<uuid>", "unified_memory:recent_observations", "llm:alex-strategic-reasoning"]
  }
}
```

**Why two layers?**

A single-layer schema conflates what is requested with what context is available. When something goes wrong, there is no way to distinguish between a bad intent specification and bad orchestration reasoning. Two layers make the failure mode explicit. If the output is wrong despite a correct enrichment, the intent schema needs refinement. If the enrichment notes were wrong, Alex's reasoning pipeline needs improvement. The layers make both problems diagnosable and trainable.

The two-layer standard also creates a clean DPO training signal. Intent + enrichment → output → eval score. Poor scores with good intent schemas identify enrichment failures. Poor scores with poor intent schemas identify schema design failures. These are different problems with different solutions.

**Implementation**

Alex's `orchestrateTask()` function enforces this standard via the `// TRUSTCORE STANDARD` comment block and `enrichTask()`. No task reaches a sub-agent without passing through enrichment. The `enrichTask()` function:

1. Calls `searchKnowledgeBase(taskTitle)` — finds relevant KB entries
2. Calls `readUnifiedMemory(taskTitle, { event_type: 'observation', limit: 5 })` — finds recent relevant observations
3. Uses qwen2.5:14b to generate strategic notes from the combined context
4. Returns the intent schema with the enrichment block appended

The intent layer is never touched. The enrichment block is always additive.

### Human Review Workflow

The current system handles `needs_review` evaluations by logging an event to unified_memory and moving on. There is no surface in Mission Control that makes flagged items visible, no mechanism for the user to provide feedback, and no path from the user's decision back to the agent's execution. The review log is a dead end.

The target state closes this loop completely. When the eval agent flags a task as `needs_review`, Alex surfaces it directly in the Chat tab — not as a notification, but as a natural language message that gives the user everything they need to act. "Hey Dave, the Marco Rossi email is ready but I flagged it for your review before we send. Composite score 3.2 — personalization was weak. Want to see it?" The user responds conversationally. Alex routes their decision: approve and send, request a specific revision, or reject entirely.

This makes Alex's role explicit. He is not just a task dispatcher — he is the interface between the system's automated work and the human's judgement. Flagged items are not errors. They are the system's honest acknowledgement that certain outputs benefit from a human eye before they go out the door.

The review workflow completes the feedback loop that feeds DPO training. Every user decision — approve, revise, reject — generates a labeled preference pair. The eval score explains why the output fell short. The user's decision defines what better looks like. These pairs are exactly the training signal the factory needs to improve the model's schema execution quality over time.

### The Delivery Gap

The email-writer in its current state produces text. That text is stored in `tasks.result` and is visible only to the database and to whatever process queries it directly. No email has ever been sent. No human has ever seen a draft surface in a review queue. The gap between "output stored" and "email delivered" is the entire value of the agent.

Closing this gap requires three additions.

The SMTP tool in `tools/send-smtp.ts` handles actual email delivery — it reads the draft from the task result, applies the delivery configuration from the schema, and sends via the configured SMTP server.

The review queue in Mission Control surfaces flagged drafts as interactive task cards with Approve, Revise, and Reject actions that write directly back to the task record. Approve triggers the SMTP tool. Revise opens a feedback thread that the agent uses as a correction signal. Reject archives the draft and notifies Alex.

Delivery confirmation is written to unified_memory when a send succeeds, creating a persistent record that the email was sent, when, and to whom. Recipient response tracking — detecting replies and routing them back as new tasks — is a future capability that the memory system is already designed to support.

Until all three components exist, the email-writer is a sophisticated text generator. After they exist, it is an autonomous email agent.

### Model Sizing Strategy

Freeform agents need large models to compensate for ambiguity. When the instructions are vague, the model's general reasoning capability is the primary quality lever. Larger models handle underspecified instructions better because they can draw on broader contextual knowledge to fill in the gaps.

Schema-driven agents invert this relationship. When the instructions are precise — when the schema specifies exactly what to produce, with what constraints, drawing on which memories, evaluated against which dimensions — the model's job is execution, not interpretation. Execution does not require a large model. It requires a model that is very good at the specific type of execution it will always be asked to do.

This has significant implications for model sizing across the agent stack:

| Agent role | Model target | Reasoning |
|---|---|---|
| Schema execution (email-writer v2) | 1b–3b custom trained | Narrow task, high repetition, schema provides all context |
| Novel type detection | 9b | Requires broader reasoning to recognize genuinely new patterns |
| Alex orchestration and routing | 14b | Coordination, priority judgements, user-facing communication |
| Complex reasoning and architecture | 35b (future) | Reserved for genuinely hard multi-step reasoning tasks |

A 3b model trained specifically on email schema execution will outperform a 9b general model on this task, because the training process optimizes exactly the behavior the schema protocol requires. The smaller model runs faster, uses less VRAM, and allows GPU 0 to handle more concurrent sub-agent requests. The schema protocol is not just an architectural improvement — it is the prerequisite for practical model specialization.

### Connection to the DPO Training Pipeline

Every successful schema execution is a (schema, output) pair. The schema defines what was asked. The output is what the agent produced. These pairs accumulate automatically in the database as the agent works.

The eval agent scores each execution against the schema's own `eval` block — the dimensions and threshold that were defined when the schema was authored. High-scoring executions become positive training examples: this is what good schema execution looks like for this type. Low-scoring executions, especially those that went through a revision cycle before approval, become preference pairs: given this schema, the first output was worse than the revised output, and here is the scored difference.

This is targeted self-improvement. The model does not improve at general instruction-following — it improves at executing the specific schemas it actually encounters in production, measured against the specific criteria that matter for those schemas. The training distribution matches the inference distribution exactly, which is the fundamental requirement for effective DPO training.

The automation is complete end to end. The agent executes. The eval agent scores. The factory harvests pairs above the quality threshold. The DPO round runs when enough pairs accumulate. The new model weights replace the old ones. The agent wakes up measurably better at the tasks it actually does. No human intervention required at any step after the initial schema is authored.

### Build Sequence for the Skill Library

The skill library rolls out in seven sub-phases within Phase 9:

**Phase 9a — Schema format standard.** Define the JSON schema specification that all skill schemas must conform to, including the standard field names, the type system for delivery methods and eval dimensions, and the validation logic that rejects malformed schemas at load time. This is the contract that everything else is built on.

**Phase 9b — Convert email-writer to schema-based execution.** Migrate the existing email-writer from freeform prompt generation to schema-driven execution. The `execute-schema.ts` workflow handles all known types. Output quality should be equal to or better than the current implementation for all existing task types.

**Phase 9c — Novel type detection.** Build the `classify-email-type.ts` workflow that routes incoming tasks either to `execute-schema.ts` (known) or `handle-novel.ts` (unknown). The detection logic should be conservative — when in doubt, treat as novel rather than forcing a poor schema match.

**Phase 9d — Alex escalation for novel types.** Build the `handle-novel.ts` workflow including the Alex escalation protocol, the schema definition collaboration process, and the schema persistence pipeline that saves new schemas to the `skills/` directory.

**Phase 9e — Skill promotion pipeline.** Build the tooling that monitors novel type frequency and automatically promotes high-frequency novel types to first-class schema status, flagging them for schema definition rather than waiting for a human to notice.

**Phase 9f — Specialist model training.** Once the schema execution database is large enough to produce quality DPO pairs, train the first specialist model on email schema execution via the existing factory pipeline. Evaluate against the current general-purpose model. Promote if it outperforms.

**Phase 9g — Protocol rollout.** Extend the schema protocol to the Sage and all subsequent specialist agents. Every new agent that joins the swarm is schema-driven from day one.

### The Broader Vision

The skill library and schema protocol are the architectural foundation for everything TrustCore becomes after the initial build. Every specialist agent that follows the email-writer — Tim managing codebase maintenance schemas, Eve running structured evaluation schemas, future agents for calendar management, supplier communications, financial reporting — follows the same pattern. One protocol, one skill library structure, one training pipeline, one review workflow.

This transforms TrustCore from a collection of general-purpose LLM agents into a structured business process automation platform. The distinction is fundamental. General-purpose LLM agents are powerful but unpredictable, expensive to run at scale, and difficult to improve systematically. Schema-driven agents are predictable by design, cheap to run on specialist hardware, and improve continuously through the DPO pipeline without human intervention.

The LLMs do not go away — they remain the intelligence within the workflows. But they are no longer asked to define the workflows themselves. The workflows are defined by humans, refined by experience, and encoded in schemas that make the agent's behavior inspectable, reproducible, and improvable. This is the architectural foundation that makes long-term autonomous operation possible — not just months from now, but years from now, when the system has accumulated enough schema execution history to train models that are genuinely world-class at the specific tasks TrustCore actually does.

---

## Part 10: How to Use This Document

### For Claude Code sessions

Every Claude Code session that works on this codebase should start with:

```
Read ARCHITECTURE.md completely before doing anything.
Then read the relevant section for what we're building today.
Then proceed.
```

This document is the memory that persists across sessions. You should never have to re-explain the two-tier memory system, the DPO pipeline, or the sandbox evolution concept to a new Claude Code session. It reads this document and it knows.

### For new contributors

Read this entire document before touching any code. The architecture is intentional. If something seems wrong or over-engineered, read the relevant section again — there is almost certainly a reason for it that is explained here. If you still disagree, open a discussion rather than changing it unilaterally.

### For agents working on the codebase

Yes, this means you. If you are an AI agent that has been given access to this codebase, read this document first. Understand the vision. Do not optimize locally at the expense of global coherence. Do not remove the comment explaining why unified_memory and agent_memory are separate tables just because the code would be simpler with one table. The architecture is the product.

### Updating this document

This document should be updated whenever:
- A major architectural decision is made or changed
- A new phase is completed
- A design decision turns out to be wrong and needs to be corrected
- A new subsystem is added

Keep the build sequence table current. Future contributors and future AI sessions use it to understand where the project is and what comes next.

---

## Part 11: Scaling Architecture & Agent Lifecycle

### The Scaling Problem

The naive extension of TrustCore's agent model — one fine-tuned model per task type, one container per agent instance — breaks fast. An organization with 50 workflow types and 100 concurrent tasks would require 50 fine-tuned models and 100 running containers. Each model consumes storage, each container consumes VRAM, and the management overhead grows nonlinearly. By the time you reach 30 task types, you've built yourself an operations problem that rivals running a small cloud provider.

The solution is not to avoid specialization. Specialization is exactly what makes schema-driven agents good. The solution is to make the right distinction between what needs to be unique and what can be shared.

### The Role Type Model

Organizations don't have unique job functions per employee. They have role types — email writer, researcher, analyst, developer — that repeat at scale. The same role type applies to many different instances of work. TrustCore mirrors this structure. The goal is 50–100 distinct role types, each defined by a schema library and optionally a fine-tuned model, covering the overwhelming majority of organizational needs. Agent instances then scale horizontally — multiple containers running the same schema against different tasks — rather than vertically by creating new unique models for every new task type.

This is the difference between a factory with 50 production lines and one with 1000 unique machines. The factory with production lines scales. The one with unique machines does not.

### The Model Registry

Four to six base models cover approximately 90% of all tasks across the agent swarm:

| Model size | Primary use |
|---|---|
| 0.5b | Simple classification, routing decisions, intent detection |
| 3b | Schema execution — the workhorse for most business tasks |
| 7b | Complex reasoning, novel type handling, technical analysis |
| 14b | Alex orchestration, user-facing communication, architectural decisions |
| 35b | Future — complex multi-step reasoning when hardware allows |

Fine-tuned models are created only for three scenarios: tasks where a base model genuinely fails to meet quality threshold even with a well-designed schema; high-volume tasks where even a small quality improvement compounds across thousands of executions; and domain-specific knowledge that cannot be practically encoded in a schema or knowledge base entry.

Tim manages the model registry. When Tim creates or registers a fine-tuned model, he records: the model version, the base model it was fine-tuned from, the training job ID, benchmark scores across all relevant eval dimensions, the task types it covers, current usage metrics, and a retirement threshold. Models that are unused for 90 days and whose covered task types are adequately served by a schema-driven base model are flagged for retirement review. Tim proposes the retirement; a human approves or defers.

### Memory Architecture at Scale

At scale, a flat per-agent memory model creates two problems. First, memory explosion — if every instance of the email-writer writes to its own private journal, the agent_memory table grows O(instances × tasks) rather than O(tasks). Second, knowledge isolation — valuable learning accumulated by one instance is invisible to other instances of the same role.

The solution is a three-tier memory model:

**Shared consciousness** — `unified_memory`, org-wide, always on. Every agent reads it. Every agent writes headlines about what it did. This does not scale with instance count — one record per event regardless of how many instances processed work that day.

**Role memory** — shared by all instances of a role type. All email-writer containers read from and write to the same email-writer agent_memory namespace. A lesson learned by one instance — a recipient preference discovered, a tone calibration that landed well — is immediately available to all other instances. Role memory scales with the number of distinct role types, not the number of instances.

**Individual memory** — namespaced by task, case, or customer, and time-limited. An email thread with a specific client gets its own memory context that lives as long as the engagement and expires when it closes. This prevents memory from accumulating indefinitely while preserving the context that matters for active work.

### Tim — Infrastructure & Integration (Full Role)

*See Part 5d for Tim's full department structure, the 90-day pilot model, and his team's individual roles.*

Tim is not a codebase maintenance utility. He is the infrastructure lifecycle manager for the entire TrustCore swarm. He is to the agent infrastructure what a lead platform engineer is to a software organization — the person responsible for making sure the tools work, the pipelines are healthy, and the system can grow without collapsing under its own weight.

Tim's responsibilities span six domains:

**Model registry management.** Tim registers new models, tracks versions, runs benchmark suites, monitors quality drift over time, and initiates retirement for obsolete models. He maintains the source of truth for what models are running and why.

**Container lifecycle.** Tim creates new agent containers when a new role type is approved, deploys them following the standard health-check protocol, monitors their ongoing health, and deprecates containers when role types are merged, retired, or replaced by better alternatives.

**Schema versioning.** When a skill schema changes — new fields added, delivery logic updated, eval thresholds adjusted — Tim tracks the version history and migrates any in-flight tasks that were created against an older schema version. Existing tasks never break silently because of a schema change.

**Codebase health monitoring.** Tim runs scheduled sweeps of the codebase looking for patterns that indicate technical debt: duplicated logic that should be shared, growing functions that should be decomposed, test coverage gaps, and dependency drift. He flags findings and proposes remediations, but does not merge changes autonomously — he submits PRs for human review except for clearly mechanical cleanups.

**Autonomous repair.** When Alex's heartbeat detects a service failure and the known_fixes library has no match, Alex invokes Tim. Tim reads the error logs, reads the relevant source files, identifies the probable root cause, writes a fix on a test branch, runs the test suite, and submits a PR if tests pass. If tests fail, he escalates to human attention with a full diagnostic report.

**On-call mode.** Tim is normally scheduled for maintenance windows. Alex can invoke Tim outside those windows for urgent infrastructure issues using priority 1 invocation. Tim has a separate on-call task queue that Alex can write to directly, bypassing normal scheduling.

Tim's model allocation: 9b for routine maintenance tasks (schema validation, container health checks, dependency scans); escalates to 14b for complex architectural decisions that require reasoning across multiple subsystems simultaneously.

### Agent Spawning Protocol

Any permanent agent — Alex, Tim, and future chiefs — can spawn additional instances of a sub-agent role using the same model as the existing instances of that role. The resource manager gates all spawning decisions through `getAvailableSlots(modelName)`, which returns the number of additional instances that can run simultaneously given current VRAM availability and the model's known memory footprint.

Spawned instances are ephemeral. They receive a specific sub-task, execute it, report results to their parent, and terminate. The parent agent that spawned them is permanent. Only permanent agents maintain ongoing memory, heartbeat, and identity. Spawned instances inherit the role's schema library and memory namespace but do not accumulate individual state.

This enables parallel execution of workload spikes without permanent resource commitment. When Tim has twenty files to refactor, he spawns twenty instances that each refactor one file in parallel. When they finish, VRAM is released and the next job can proceed. The system does not need to pre-provision resources for worst-case concurrency — it scales dynamically within the physical VRAM envelope.

### Demand-Driven Instance Scaling — The Archivist Pattern

The Archivist (and any agent with parallelizable workload) supports horizontal scaling on demand. When backlog exceeds a manageable threshold, the agent requests additional capacity from Tim rather than processing sequentially and falling behind.

**The request pattern:**
The Archivist monitors its own queue depth. When unprocessed chunks exceed a configured threshold (default: 200 chunks), it files a work order to Tim via the task queue:

  "I have {N} chunks to process at a current rate of {R} per hour. Estimated clearance time: {T} hours. Requesting {X} additional instances for {Y} hours. VRAM estimate: {Z} GB per instance."

Tim evaluates available VRAM via the resource manager, approves or modifies the request within Dave's pre-approved scaling policy, and spins up the requested instances.

**How parallel instances share work without coordination:**
The work queue is the database. Memory chunks awaiting processing are rows in memory_chunks. Multiple Archivist instances claim work using PostgreSQL's SKIP LOCKED pattern:

  SELECT id, content_text FROM memory_chunks
  WHERE archived = false AND processed = false
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 10;

This prevents two instances from processing the same chunk without requiring any inter-process coordination. Each instance claims its batch, processes it, marks it complete, and claims the next batch. No message broker, no distributed lock manager — the database handles it.

**Identity and memory are not duplicated:**
Ephemeral instances inherit the Archivist's Soul.md and Agent.md but do not accumulate individual memory or identity. They are the Archivist's hands, not additional Archivists. When the backlog clears, Tim shuts them down and the resources are released. Only the permanent Archivist instance maintains ongoing memory and heartbeat.

**Pre-approval policy:**
Tim does not ask Dave for permission on every scaling event. Dave pre-approves a scaling policy stored in unified_memory:

  "Archivist may request up to 4 instances when backlog exceeds 200 chunks. Maximum concurrent VRAM allocation: 8GB. Maximum instance lifetime: 8 hours."

Tim executes within this policy autonomously. Requests that exceed policy limits escalate to Dave for approval before execution. The pre-approval hash is stored in unified_memory so Tim can verify Dave authorized this class of action in a past conversation.

**Why this matters:**
This is the first concrete implementation of the agent spawning protocol described earlier in Part 11. The Archivist pattern is clean because the work is perfectly parallelizable — chunks are independent, the queue is self-coordinating, and instances are truly stateless. Future agents with similar workload profiles (batch evaluation runs, bulk knowledge base ingestion, parallel web research) should follow the same pattern.

---

## Part 12: Soul/User Identity System

### The Problem

Agents in TrustCore's current state have no persistent identity. Each invocation starts fresh with the same generic system prompt. The email-writer does not know who it is, who it is serving, what voice it should write in, or what the user has told it about their communication preferences across all their previous interactions. Every email is written by a stranger who happens to know how to write emails.

This produces three problems that cannot be fixed by better prompting at the call site. First, voice inconsistency — every output sounds like it came from a different person. Second, tone mismatch — the agent cannot calibrate formality, warmth, or urgency to the specific relationship without persistent knowledge of the principal. Third, preference blindness — the user has to re-specify their preferences every time rather than having the system accumulate and apply them automatically.

The Soul/User Identity System solves all three by giving every agent two persistent identity documents that are loaded in full at startup, before any task is processed.

### The Document Hierarchy

Identity in TrustCore operates across four levels, each governing the one below it:

**Foundation.md** — the highest document. Defines why TrustCore exists and who it serves. All agents operate under it. Its contents are for the principals, not the technical architecture — but every Soul.md and User.md must reference it as their north star.

**Shared Soul.md** — TrustCore's collective identity and mission statement. Every agent reads it. No individual agent's Soul.md can override it.

**Individual Soul.md** — each agent's unique character within the shared framework.

**User.md** — who each agent directly serves, maintained and updated by Alex as understanding deepens.

Foundation.md is the ceiling and the floor for all of it.

### Two Identity Documents Per Agent

**Soul.md** is the agent's character definition. It describes who the agent is, what it is for, how it communicates, what it will and will not do, and how it relates to other agents in the hierarchy. Soul.md is the agent's professional identity — stable, consistent, and distinctive. It is not a prompt template. It is not a list of instructions. It is a character, written the way a character is written: with voice, with values, with a clear sense of self.

**User.md** is everything the agent knows about who it serves. It contains the principal's name, role, and organizational context; their communication preferences and style; their known tendencies and work patterns; things they always want emphasized; things they never want; and behavioral rules for how the agent should interact with this specific person. User.md is the agent's institutional memory about its principal — accumulated, structured, and always current.

### Two Levels — Shared and Individual

**Shared Soul.md** is TrustCore's collective identity and mission statement. It is the most important document in the system. Every agent reads it. Every decision is made in its context. It defines what TrustCore is as a whole, what it stands for, how it treats people, what principles guide all of its agents, and what it will and will not do regardless of the task. This document functions as the organization's founding charter — the constitutional layer that no individual agent's Soul.md can override. Authoring it requires care and genuine reflection. Get it right and every agent in the swarm carries those values into every task. Get it wrong and you have trained a swarm with the wrong character.

**Shared User.md** is the universal profile for Dave — the human this system serves. Everything the whole system knows about how Dave works, what he values, how he communicates, what he is building, and why. Every agent reads it. Alex uses it for orchestration decisions and priority judgements. Sub-agents use it for output calibration. It is maintained by Alex and updated as Alex's understanding of Dave deepens through accumulated interaction.

**Individual Soul.md** gives each agent its unique character within the shared identity framework. Alex sounds different from the email-writer. The email-writer sounds different from Tim. Each has its own voice, its own expertise framing, its own professional personality — all consistent with the shared Soul but distinctly their own. The analogy is employees who share the same company culture and values but have distinct professional identities that fit their roles.

**Individual User.md** defines who each agent directly serves. Alex's direct principal is Dave. Sub-agents' direct principal is Alex — their immediate orchestrator — with Dave as super-user carrying ultimate authority. This hierarchy matters for tone and communication style. An agent communicates differently in a one-on-one with its direct principal than in a system-wide context, just as an employee is candid with their manager in a private conversation in a way they would not be in an all-hands meeting.

### Implementation

Soul.md and User.md files are stored as special entries in the `knowledge_base` table with a reserved `category` field value of `'identity'`. They are distinguished from ordinary knowledge base entries by this category and by the absence of chunking — identity documents are never split across multiple rows. They load in full.

At agent startup, identity documents are injected directly into the agent's context before any task processing begins. This is not RAG retrieval. There is no embedding search, no similarity threshold, no top-k selection. The documents are fetched by exact category query and prepended to the system context in full, in a fixed order: shared Soul.md first, shared User.md second, individual Soul.md third, individual User.md last. The agent always knows who it is and who it is serving before it reads a single task.

Identity documents are versioned. The `knowledge_base` table records a version number and timestamp for each update. When Dave updates a preference in his User.md, the change takes effect on the next agent restart without requiring any code change. The version history is preserved indefinitely — the system can reconstruct what any agent knew about its principal at any point in time, which is valuable both for debugging unexpected outputs and for understanding how the principal's preferences have evolved.

### Authoring Process

The Shared Soul.md and individual Soul.md documents are authored collaboratively between Dave and Claude in a dedicated conversation — not generated by Claude Code during a build session. This is intentional. Character requires thought. It requires the author to ask: what does this agent actually stand for? What would it refuse? What makes its voice distinctive rather than generic? How does it think about the people it serves? These questions cannot be answered well in a late-night build session when the goal is shipping features. They require a different kind of attention.

Dave's Shared User.md begins as a document Dave writes himself — a statement of how he works, what he values, and what he expects. It is seeded into the system on Day 1. From that point forward, Alex maintains it. As Alex learns more about how Dave works — through task feedback, through observed patterns, through explicit corrections — Alex proposes additions and updates. Dave reviews and approves. The document grows richer over time without requiring Dave to actively maintain it. The system does the work of remembering.

---

## Appendix: Key Design Decisions and Why

**Why PostgreSQL not SQLite?**
Multiple Docker containers write concurrently. SQLite's WAL mode handles concurrent reads but concurrent writes from separate processes cause locking contention that gets worse as the agent swarm grows. PostgreSQL handles this natively.

**Why pgvector not a separate vector database?**
Every additional service is another thing that can fail, another thing that needs monitoring, another thing the self-healing layer has to manage. pgvector gives you semantic search inside your existing database with no additional infrastructure. The query syntax is standard SQL. The data lives alongside your relational data. One less moving part.

**Why 768-dimension embeddings?**
nomic-embed-text via Ollama. Best quality-to-performance ratio for local inference. 384 dimensions (all-MiniLM) is faster but noticeably worse quality. 1536 dimensions (OpenAI) is marginally better but requires cloud API calls or a model too large for comfortable local inference.

**Why two separate memory tables instead of one with a visibility flag?**
One table with a visibility flag creates a mess at the access control layer. Every query needs `WHERE agent_id = $me OR visibility = 'unified'`. Getting this wrong leaks private agent state. Two tables with different access semantics makes the intent explicit and the MCP tool boundaries obvious. The complexity cost is one extra table. The safety benefit is permanent.

**Why database-mediated agent communication instead of direct calls?**
If Agent A calls Agent B directly and Agent B crashes mid-task, the task is lost. With database-mediated communication the task exists in the database before Agent B ever sees it. When Agent B restarts it picks up from where it left off. The database is the source of truth, not the network connection.

**Why the circular FK between unified_memory and memory_consolidations?**
unified_memory records point to the consolidation that absorbed them. memory_consolidations records point to the summary unified_memory record they created. This bidirectional reference enables efficient drill-down in both directions. The circular reference is resolved by creating unified_memory first without the FK, creating memory_consolidations, then adding the FK in a separate migration. See migrations 005-007.

**Why is the evolution engine not allowed to modify core source files autonomously?**
Source code changes are the one category where a mistake can propagate in ways that are hard to detect and hard to reverse. Model weight changes, configuration changes, schema changes — all of these have clear metrics and clear rollback paths. Source code changes can introduce subtle logic errors that pass all existing tests but break things in production in ways that aren't immediately obvious. The one human review step in the promotion pipeline is specifically for source code changes. Everything else auto-promotes if the metrics pass.

**Why GPU 0 for training and GPU 1 for inference?**
GPU 1 is connected to the display (Disp.A shows On in nvidia-smi output). Using it for heavy training while it's also rendering the desktop causes display stuttering and thermal issues. GPU 0 has no display connection and can run at full power for training without affecting system usability. This is a hardware constraint, not an arbitrary choice.

**Why exactly five core agents (the Core Five) rather than more specialists?**
Five was chosen because it matches the span of control Dave can actually supervise at the current stage of development. Each core agent has a distinct, non-overlapping domain. Adding a sixth specialist before the first five are operating reliably would spread attention and testing coverage too thin. The Bench agents (email-writer, mailbox-agent, resource-manager) remain available but are not primary — they solve narrower problems and operate under Alex's direction rather than as autonomous principals.

**Why does Tim have host shell access?**
Tim's integration and monitoring work requires running scripts that interact with the host filesystem, external APIs, and network services. These are not things that can be done through SQL or Ollama alone. Shell access is scoped to `~/integrations/` and explicitly approved. Every shell command Tim executes is logged to `agent_tool_calls`. This is the minimum necessary access for Tim to do his job — he does not have write access to agent source code, migrations, or system configuration.

**Why is character training a factory responsibility rather than a deployment concern?**
Character (Soul.md → weights) is baked into the model before deployment, not injected at runtime via system prompt. This is a deliberate design choice. Runtime prompting of character produces inconsistency — the model's default behavior leaks through under adversarial prompting or unusual task types. Baking character into weights via DPO is more robust and does not consume context window tokens on every call. The factory is responsible for producing agents that already have their character, not for supplying it call-by-call.

**Why is Archie a named agent rather than a background service?**
Archie has agency — he makes prioritization decisions, notices patterns, and determines what gets promoted to the knowledge base versus what gets discarded. A background service that runs on a fixed schedule without judgment would miss the most valuable signals (which are often irregular) and accumulate noise. Naming Archie as an agent with a specific role and Soul.md ensures his curation decisions are consistent, logged, and improvable through the same DPO pipeline as every other agent. He is a curator, not a cron job.

**Why is identity split across baked weights and runtime documents rather than all-runtime?**
All-runtime identity is simple but expensive. Loading 2,000+ tokens of identity documents before every task consumes context budget that should go to the task itself. The three-tier split recognizes that not all identity content changes at the same rate. Values and character are stable — they belong in weights where they cost nothing at inference time. Preferences and calibrations evolve — they belong in thin runtime documents. Session context is ephemeral — it belongs in memory recall. Each tier holds what it is best suited for. The result is an agent that is fully itself without paying the context cost to prove it on every call. This decision was made March 27, 2026.

**Why does Foundation.md govern everything but appear in no agent's system prompt?**
Foundation.md answers why TrustCore exists. That answer belongs in the principals' hands, not in the technical machinery. Agents operate in service of Foundation.md's purpose without loading its contents — just as an employee serves a company's mission without reciting the founding charter before every meeting. Foundation.md's influence travels through Soul.md (which references it as north star) and through the baked identity layer (which carries its ethical orientation in weights). This decision was made March 27, 2026.

**Why does Alex make the novel-combination-vs-new-specialist decision without a predefined workflow?**
A predefined workflow for this decision would freeze today's logic permanently. The "is this truly novel or a repackaging problem" judgment is exactly the kind of decision that improves through training — Alex gets better at it as Eve scores his calls and the DPO pipeline runs. A hardcoded ruleset cannot improve. A trained judgment can. The logging requirement (every novel task classification decision written to unified_memory with full reasoning) provides the oversight that a predefined workflow would otherwise supply. This decision was made March 27, 2026.

**Why is Alex subject to the same eval pipeline as every other agent?**
Because the orchestration layer is where the most consequential decisions in TrustCore get made. If routing logic, task decomposition, and novel task classification are not scored and improved over time, every specialist in the swarm is only as good as the instructions it receives — and those instructions stay static while the specialists themselves compound. Eval on Alex closes this gap. No agent is above the law. This decision was made March 27, 2026.

**Why does Jenny run tasks serially rather than in parallel?**
Parallel inference on a 7b model running 4 instances simultaneously would consume VRAM needed by the rest of the swarm. Jenny is a discovery tool, not a production workhorse — her latency is acceptable because the user is explicitly told this task type is in discovery mode. Serial execution costs time, not quality. The 4x output breadth is preserved; only the wall clock time changes. This decision was made March 27, 2026.

---

*This document was written in March 2026 at the beginning of the TrustCore project. If you are reading this from a future version of TrustCore that has implemented all eight phases, congratulations — you built something genuinely remarkable.*

---

## Adjacent Systems

### Astra

Astra is a separate AI system that operates independently of TrustCore. She is documented in `ASTRA.md` in a separate repository. TrustCore does not need to know the details of Astra's architecture. The only thing TrustCore needs to know: Alex and Astra can communicate via a WireGuard/ZeroMQ bridge when explicitly configured. All cross-system communication goes through Alex. No other TrustCore agent has visibility into or contact with Astra.

---

## Part 13: External Intelligence Layer

### 13.1 Overview

Local agents handle orchestration, memory, and execution. When a task requires frontier model capabilities — nuanced reasoning, high-fidelity image generation, real-time web search, or professional voice synthesis — agents call external AI services through the External Intelligence Layer.

This layer is not a fallback. It is a deliberate capability extension. Local Ollama models cover approximately 80% of all task volume. External services handle the remaining 20% where quality, specialization, or capability gaps make local inference insufficient. The result is frontier-grade output with zero local VRAM cost for those workloads.

The External Intelligence Layer is:
- **Transparent to the agent** — agents invoke tools, not providers directly
- **Schema-driven** — skill definitions specify which model to use, not the agent at runtime
- **Centrally credentialed** — all agents share a single credential store; no per-agent key management
- **Output-buffered** — all external outputs land in a shared staging folder before consumption

---

### 13.2 Authentication Strategy

TrustCore uses an OAuth-first authentication architecture for external AI services.

**OAuth (preferred)**

Google and Microsoft support OAuth natively across their AI product surfaces and are the preferred integration path:

| Provider | Services |
|---|---|
| Google | Gemini, Vertex AI, Veo, Cloud Vision |
| Microsoft | Azure AI Vision, Azure OpenAI |

OAuth tokens are obtained once per service, stored encrypted in PostgreSQL, and refreshed automatically on expiry. No API key rotation. No secrets in environment files.

**API Key Services**

OpenAI and Anthropic currently use API keys. Both providers are expanding OAuth support; TrustCore will migrate to OAuth as those surfaces mature.

| Provider | Auth Method | Migration Path |
|---|---|---|
| Anthropic | API key | OAuth when available |
| OpenAI | API key | OAuth when available |
| ElevenLabs | API key | API key (no OAuth roadmap) |
| Deepgram | API key | API key |
| Perplexity | API key | API key |
| Adobe Firefly | OAuth | OAuth (current) |
| Runway | API key | API key |

**AWS**

AWS services (Rekognition) use IAM roles with SigV4 request signing. Credentials are scoped to the minimum required permissions and managed via instance role where possible.

**Credential Storage**

All credentials — OAuth refresh tokens, API keys, AWS access pairs — are stored in the `external_credentials` table in PostgreSQL, encrypted at rest. All agents share the same stored credentials. There is no per-agent key management, no credential duplication, and no secrets outside the database.

---

### 13.3 The Staging Folder (Universal Output Buffer)

All outputs from external model calls — images, video, audio, text, documents — are written to a shared host filesystem staging area before any agent consumes them.

**Directory Structure**

```
/trustcore-data/staging/
  {agent-id}/
    {job-id}/
      output.*          # primary output file (image, video, audio, etc.)
      prompt.txt        # exact prompt or input sent to the model
      metadata.json     # model, provider, parameters, timestamps, token counts
```

Each job gets an isolated subfolder. The agent that initiated the job writes the subfolder at creation time and sets an expiry timestamp.

**Ownership Model**

Files never move. Ownership transfers via the `staging_files` PostgreSQL table.

When a job is created, the initiating agent inserts a row into `staging_files` with itself as `owner_agent_id` and sets `expires_at`. When the file is handed off to another agent — for example, the image-generator hands a rendered image to the email-writer — ownership transfers via a single SQL `UPDATE`:

```sql
UPDATE staging_files
SET owner_agent_id = 'email-writer',
    expires_at = NOW() + INTERVAL '2 hours'
WHERE job_id = $1;
```

The timer resets on every ownership transfer. The new owner is responsible for consuming or re-handing the file before expiry.

**Cleanup**

Tim, the infrastructure agent, runs periodic cleanup sweeps over `staging_files`. Any row where `expires_at < NOW()` and `consumed = false` is flagged for deletion. Tim removes the filesystem subfolder and marks the row as expired. No orphaned files accumulate.

**Mission Control**

The Docs tab in Mission Control is a file explorer over `/trustcore-data/staging/`. Users can browse outputs by agent, inspect prompt and metadata files, and manually extend expiry or trigger cleanup.

---

### 13.4 Schema-Defined Intelligence

External model selection is not made at runtime by agents. It is declared in the skill schema.

Each skill definition includes an `intelligence` block that specifies the primary model, an optional local fallback, and a human-readable reason for the choice:

```json
{
  "skill": "legal-summarization",
  "intelligence": {
    "primary": "anthropic/claude-opus",
    "fallback": "local/qwen2.5:14b",
    "reason": "requires nuanced legal reasoning"
  }
}
```

At execution time, the agent reads the skill schema, checks whether the primary model is reachable and within rate limits, and calls it. If the primary is unavailable, the agent falls back to the declared local model without surfacing the failure to the user.

This approach keeps routing logic out of agent code and into configuration. Changing which model a skill uses is a schema edit, not a code change.

Approximately **80% of tasks use local models** and have no `intelligence` block or specify a `local/*` primary. External intelligence is invoked only when the skill schema explicitly calls for it.

---

### 13.5 The Full Toolbox

#### Reasoning

| Model | Provider | Notes |
|---|---|---|
| Claude Opus / Sonnet | Anthropic | Default for complex reasoning, legal, analysis |
| GPT-5.4 / GPT-5.4 mini | OpenAI | General reasoning; mini for cost-sensitive tasks |
| Gemini (Pro / Flash) | Google | Multimodal reasoning; Flash for high-volume |

#### Code

| Model | Provider | Notes |
|---|---|---|
| GPT-5-Codex | OpenAI | Code generation and completion |
| Claude Sonnet | Anthropic | Code review, refactoring, explanation |

#### Image Generation

| Model | Provider | Notes |
|---|---|---|
| GPT Image 1.5 | OpenAI | General image generation |
| Gemini 2.5 Flash Image | Google | Fast, cost-efficient image generation |
| Adobe Firefly | Adobe | Brand-safe, commercially licensed output |
| Runway | Runway | Stylized image generation; shared with video |

#### Video Generation

| Model | Provider | Notes |
|---|---|---|
| Sora 2 | OpenAI | High-fidelity text-to-video |
| Veo 3.1 | Google | Long-form video generation |
| Runway Gen-4.5 | Runway | Stylized, fast video generation |

#### Voice — Speech to Text

| Model | Provider | Notes |
|---|---|---|
| GPT-4o Transcribe | OpenAI | High-accuracy transcription |
| Deepgram Nova / Flux | Deepgram | Real-time and batch STT |

#### Voice — Text to Speech

| Model | Provider | Notes |
|---|---|---|
| ElevenLabs Flash / Turbo | ElevenLabs | Low-latency, high-quality voice synthesis |
| GPT-4o mini TTS | OpenAI | Cost-efficient TTS for high-volume tasks |

#### Web Search

| Tool | Provider | Notes |
|---|---|---|
| Perplexity API | Perplexity | Research-grade search with citations |
| Google Search Grounding | Google | Grounded Gemini responses via Search |
| OpenAI Web Search | OpenAI | Web-augmented GPT responses |

#### Vision / OCR

| Tool | Provider | Notes |
|---|---|---|
| Cloud Vision API | Google | OCR, object detection, document parsing |
| Rekognition | AWS | Image and video analysis |
| Azure AI Vision | Microsoft | OCR, spatial analysis, custom models |

#### Embeddings

| Model | Provider | Notes |
|---|---|---|
| nomic-embed-text | Local (Ollama) | **Primary** — zero cost, runs locally |
| text-embedding-3-large | OpenAI | High-dimensional embeddings for precision tasks |
| Gemini Embedding 2 | Google | Multimodal embedding support |

---

### 13.6 File Structure

External tool integrations live under `src/tools/external/`, organized by capability category:

```
src/tools/external/
  reasoning/
    anthropic.ts          # Claude API client and tool wrapper
    openai.ts             # GPT client and tool wrapper
    gemini.ts             # Gemini client and tool wrapper
  image/
    openai-image.ts       # GPT Image generation
    gemini-image.ts       # Gemini image generation
    firefly.ts            # Adobe Firefly integration
    runway.ts             # Runway image generation
  video/
    sora.ts               # OpenAI Sora integration
    veo.ts                # Google Veo integration
    runway-video.ts       # Runway video generation
  voice/
    elevenlabs.ts         # ElevenLabs TTS
    deepgram.ts           # Deepgram STT
    openai-audio.ts       # GPT-4o Transcribe and TTS
  search/
    perplexity.ts         # Perplexity search API
    google-grounding.ts   # Google Search Grounding
    openai-search.ts      # OpenAI web search tool
  vision/
    google-vision.ts      # Google Cloud Vision API
    rekognition.ts        # AWS Rekognition
    azure-vision.ts       # Azure AI Vision
```

Each file exports a single tool wrapper that:
1. Reads credentials from the `external_credentials` table
2. Calls the external API
3. Writes output to the staging folder
4. Inserts a row into `staging_files`
5. Returns the `job_id` to the calling agent

Agents never interact with provider SDKs directly. All external calls go through these wrappers.

---

### 13.7 The `staging_files` Database Table

The `staging_files` table is the ownership ledger for all external model outputs. It tracks what was produced, who owns it, whether it has been consumed, and when it expires.

```sql
CREATE TABLE staging_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL UNIQUE,
  owner_agent_id  VARCHAR(64) NOT NULL,
  file_path       TEXT NOT NULL,
  file_type       VARCHAR(32) NOT NULL,   -- 'image', 'video', 'audio', 'text', 'document'
  prompt          TEXT,
  model           VARCHAR(128) NOT NULL,  -- e.g. 'anthropic/claude-opus', 'openai/sora-2'
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_staging_files_owner ON staging_files (owner_agent_id);
CREATE INDEX idx_staging_files_expires ON staging_files (expires_at) WHERE consumed = false;
```

**Ownership Transfer Pattern**

Ownership is transferred with a single atomic `UPDATE`. The receiving agent resets the expiry to its own processing window:

```sql
-- Agent B takes ownership from Agent A
UPDATE staging_files
SET
  owner_agent_id = 'email-writer',
  expires_at     = NOW() + INTERVAL '2 hours'
WHERE
  job_id = $1
  AND consumed = false;
```

When an agent finishes consuming a file, it marks the row as consumed:

```sql
UPDATE staging_files
SET consumed = true
WHERE job_id = $1;
```

Consumed rows are retained for audit purposes. Tim's cleanup sweeps only delete filesystem contents and flag rows where `consumed = false AND expires_at < NOW()`.

---

### 13.8 Cost and Rate Limit Philosophy

TrustCore's external AI spend is managed through two complementary mechanisms: OAuth subscriptions and API key monitoring.

**OAuth Subscriptions — Fixed Cost, Natural Rate Limiting**

Google and Microsoft services accessed via OAuth operate under subscription plans with fixed monthly costs. There are no per-token charges on these surfaces. Rate limits are enforced by the provider as a function of the subscription tier, which acts as a natural spend guardrail. No budget alerts, no surprise overages — the subscription is the ceiling.

**API Key Services — Monitored via `agent_tool_calls`**

OpenAI, Anthropic, ElevenLabs, Deepgram, and other API key services log every call to the `agent_tool_calls` table:

```sql
-- Relevant columns in agent_tool_calls
tool_name       VARCHAR(128),   -- e.g. 'openai.image', 'anthropic.claude-opus'
agent_id        VARCHAR(64),
tokens_in       INTEGER,
tokens_out      INTEGER,
estimated_cost  NUMERIC(10, 6),
called_at       TIMESTAMPTZ
```

Alex monitors this table and can surface cost summaries, flag unusual spend patterns, or pause a specific tool if a rate limit is approaching. Rate limits on API key services reset daily. There is no mechanism in TrustCore to accumulate unbounded spend between resets.

**Design Principle**

External intelligence is invoked explicitly, not speculatively. Because model selection is schema-driven and 80% of tasks run locally, external API calls are intentional events, not ambient background noise. This keeps cost predictable and the `agent_tool_calls` log meaningful.
