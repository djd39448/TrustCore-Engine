# TrustCore Engine — Master Architecture Document

**Version:** 1.0  
**Status:** Active blueprint — all build phases reference this document  
**Last updated:** March 2026  
**Author:** Dave + Claude

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

TrustCore has five major subsystems. Each one is described in detail in its own section below.

**1. The Agent Framework** — Alex (chief of staff) plus a swarm of specialized sub-agents, each running a local LLM via Ollama, each with their own tools and skills.

**2. The Memory System** — A two-tier SQL + vector database that gives every agent persistent memory across sessions, with unified shared consciousness and private individual journals.

**3. The Training Factory** — An autonomous pipeline built on autoresearch that trains, evaluates, and deploys specialized small LLMs, then continuously improves them through DPO fine-tuning on their own performance data.

**4. The Self-Healing Layer** — A monitoring and diagnosis system that detects failures, applies known fixes automatically, and invokes autonomous repair for novel failures.

**5. The Evolution Sandbox** — A containerized clone environment where architectural experiments run in complete isolation from production. Only validated improvements promote to production.

These five subsystems are not independent — they feed each other. Better architecture means better healing. Better healing means more reliable training data. Better training data means smarter agents. Smarter agents generate better architectural insights. The whole system compounds over time.

---

## Repository Structure

```
trustcore-engine/           ← This repo — core framework
trustcore-factory/          ← Training factory and model pipeline  
mission-control/            ← Next.js dashboard UI (separate repo)
```

All three repos work together but are deliberately separated. The engine is the brain. The factory is the improvement mechanism. Mission Control is the window into the system.

---

## Part 1: The Agent Framework

### Alex — Chief of Staff

Alex is the primary agent. He is always on. He never sleeps between sessions. He is the human's primary interface to the entire TrustCore system and the orchestrator of all sub-agents.

Alex's responsibilities:
- Receive and interpret requests from the human via Mission Control
- Break complex tasks into subtasks and dispatch them to specialized sub-agents
- Monitor sub-agent progress and handle failures
- Maintain the unified memory — writing events for everything that happens
- Run the heartbeat loop every 30 minutes
- Run the memory consolidation sweep periodically
- Monitor system health and trigger self-healing when needed
- Monitor training data thresholds and trigger retraining cycles

Alex runs on a capable local LLM via Ollama. The default model is configurable but should be the largest model your hardware can run comfortably while leaving GPU headroom for sub-agents and training jobs.

**Alex's heartbeat** is the nervous system of TrustCore. Every 30 minutes it:
1. Writes a pulse to unified_memory
2. Checks system health tables for any degraded or dead services
3. Checks feedback thresholds to see if any agent needs retraining
4. Checks if any evolution sandbox experiments are complete and ready for evaluation
5. Runs memory consolidation if the unified_memory table exceeds the consolidation threshold
6. Logs a summary of what it found and what actions it took

### Sub-Agents

Sub-agents are small specialized LLMs fine-tuned for a single narrow task. They live in Docker containers. They sit idle until called. They are extraordinary at their specific job and do nothing else.

The current sub-agent roster:
- **email-writer** — drafts emails given a brief
- **mailbox-agent** — handles actual email sending via SMTP
- **research-agent** — web search and summarization (planned)

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
- GPU 1: production `ollama-gpu1` (Alex, 35b permanent) + sandbox experiment Ollama instances
- GPU 0: production `ollama-gpu0` (sub-agents) + training factory

Note: on Windows Docker Desktop, GPU assignment between containers is not hardware-enforced — see the GPU isolation note in Part 6. On Linux/WSL2 with NVIDIA Container Toolkit, sandbox Ollama instances can be pinned to specific GPUs via `NVIDIA_VISIBLE_DEVICES`.

Multiple hypotheses compete simultaneously. The best one gets promoted. The others get destroyed. This is genuine parallel evolution — multiple architectural mutations competing, with only the fittest surviving.

---

## Part 5b: Infrastructure Safety Settings

These settings exist to prevent resource exhaustion that would crash the entire system. Do not remove them.

### OLLAMA_MAX_LOADED_MODELS

`OLLAMA_MAX_LOADED_MODELS` is set differently on each Ollama instance:

- **`ollama-gpu1`: `OLLAMA_MAX_LOADED_MODELS=1`** — only one model may be loaded at a time. Combined with `OLLAMA_KEEP_ALIVE=-1`, this permanently holds `qwen3.5:35b-a3b` (20 GB) in VRAM and refuses to load anything else. This is intentional: GPU 1 is Alex's exclusive home. Do not raise this value.

- **`ollama-gpu0`: `OLLAMA_MAX_LOADED_MODELS=8`** — Ollama's internal concurrency cap is deliberately high because the resource manager enforces the real VRAM budget via `acquireSlot()` and the `GPU0_AVAILABLE_MB=22528` constant. Letting Ollama manage up to 8 runners allows faster context switching between small models (9b, 4b, 2b, nomic-embed-text).

**Why `OLLAMA_MAX_LOADED_MODELS=1` was originally added (the BSOD incident):** Early in development, two large models loaded simultaneously (qwen3.5:35b-a3b + qwen3.5:9b, ~26 GB combined) caused a GPU driver crash and BSOD. The fix was the single-model limit plus the LLM priority queue. The dual-Ollama architecture is the evolved solution — each instance is sized for its role so simultaneous loads across instances stay within the 24 GB budget per GPU.

### LLM Request Timeout

All LLM calls in `src/llm/client.ts` have a 120-second hard timeout enforced via `AbortController`. If an Ollama request hangs (network stall, model deadlock, OOM swap), the call is aborted after 120 seconds and returns `null`. The calling agent logs the timeout and moves on to the next task. Without this timeout, a single hung LLM call blocks the agent loop indefinitely, causing tasks to pile up in `in_progress` status with no way to recover without a container restart.

---

## Part 6: GPU Resource Manager

### The Two-GPU Strategy

TrustCore runs on a system with two RTX 3090 GPUs, each served by its own dedicated Ollama instance:

- **GPU 1 — Alex's permanent home** (`trustcore-ollama-gpu1`, port 11434). The `qwen3.5:35b-a3b` model is always loaded here with `OLLAMA_KEEP_ALIVE=-1` so it is never evicted. `OLLAMA_MAX_LOADED_MODELS=1` enforces that no other model can displace it. Alex, the API server, the MCP server, and the resource manager all route to this instance. Sub-agent work is never sent here.

- **GPU 0 — Shared execution pool** (`trustcore-ollama-gpu0`, port 11435). Used by email-writer, research, and the training factory. `OLLAMA_KEEP_ALIVE=0` means models are evicted immediately after each request, keeping VRAM free for the next job. `OLLAMA_MAX_LOADED_MODELS=8` allows Ollama's internal scheduler to handle concurrency while the resource manager enforces the real VRAM budget.

The resource manager tracks live VRAM usage on GPU 0 and gates dispatch through `getAvailableSlots()`, `canDispatchNow()`, and `acquireSlot()`. GPU 1 VRAM is treated as fully committed — the resource manager never schedules sub-agent work there regardless of available headroom.

### Windows Docker Desktop — GPU Isolation Limitation

**`NVIDIA_VISIBLE_DEVICES` and `device_ids` in the `deploy.resources` section are not enforced by Docker Desktop on Windows.** Both `ollama-gpu1` and `ollama-gpu0` containers see both physical GPUs and report a combined 48 GB VRAM pool. Ollama manages GPU placement dynamically, loading models onto whichever GPU has the most available VRAM at the time.

In practice this means:
- The logical separation is real — different agent groups talk to different Ollama instances, and `OLLAMA_MAX_LOADED_MODELS=1` on gpu1 prevents the 35b model from being displaced.
- The hardware-level GPU pinning is not enforced — Ollama may place a sub-agent's 9b model on GPU 1's physical silicon if it has more free VRAM at the moment.
- The combined 48 GB pool actually improves throughput on this hardware — Ollama can fit more models simultaneously than either GPU alone could.

**If strict GPU pinning is required** (e.g., to guarantee GPU 1 is 100% dedicated to the 35b model with zero sharing), the system must run under WSL2 with NVIDIA Container Toolkit on Linux, where `NVIDIA_VISIBLE_DEVICES` is fully respected at the kernel level. On Windows Docker Desktop this is a known limitation with no workaround.

### The BSOD Incident

Early in development, running multiple Ollama model loads simultaneously caused a system crash (BSOD). Root cause: two large models (qwen3.5:35b-a3b + qwen3.5:9b) attempted to load into VRAM simultaneously when agents processed tasks concurrently. Combined VRAM requirement exceeded 24 GB, causing the GPU driver to crash the system.

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

### Phase 3 — Mission Control Connection (next)
- Replace localStorage in Mission Control with live database queries
- Wire the mission-control MCP server to the Next.js dashboard
- Tasks kanban shows real tasks from the database
- Activity feed shows real unified_memory events
- Agent status shows real health data
- Estimated: 1 week of evening sessions

### Phase 4 — Training Factory
- autoresearch integration in WSL on GPU 0
- Instruction tuning pipeline with LoRA
- GGUF conversion and Ollama loading
- Agent registration pipeline
- Quality evaluation suite
- Estimated: 1-2 weeks

### Phase 5 — Feedback and DPO Pipeline
- feedback table migration
- training_jobs and model_versions tables
- Feedback harvester service
- Autonomous retraining trigger logic
- DPO training integration
- Quality gate implementation
- Estimated: 1-2 weeks

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

**Total estimated timeline from current state: 8-10 weeks of evening sessions**

---

## Part 9: How to Use This Document

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

---

*This document was written in March 2026 at the beginning of the TrustCore project. If you are reading this from a future version of TrustCore that has implemented all eight phases, congratulations — you built something genuinely remarkable.*
