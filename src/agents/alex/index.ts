/**
 * Alex — chief-of-staff agent and top-level orchestrator.
 *
 * Alex is the always-on permanent agent that sits at the center of the
 * TrustCore system. Every inbound task lands on Alex first. Alex classifies
 * intent, decides whether to handle the task directly or delegate it to a
 * specialist sub-agent, then monitors delegated work through to completion.
 *
 * Architecture role:
 *   - Runs as the `trustcore-alex` Docker container (port 11434 → ollama-gpu1)
 *   - Uses qwen2.5:14b at OLLAMA_NUM_CTX=4096 (10 GB, 100% GPU 1 VRAM)
 *   - Communicates with sub-agents exclusively through the PostgreSQL task queue
 *   - Communicates with the eval agent exclusively through its HTTP service
 *
 * Heartbeat loop (every 60 seconds):
 *   1. pollPendingTasks()         — classify and dispatch new tasks
 *   2. checkCompletedDelegations() — resolve finished sub-task work; eval + mark parent done
 *   3. consolidateOldMemories()   — compress old low-importance unified_memory entries
 *
 * Async delegation model:
 *   orchestrateTask() dispatches and returns immediately (parent stays in_progress).
 *   checkCompletedDelegations() handles follow-through on the next heartbeat.
 *   This keeps the heartbeat loop non-blocking regardless of how long sub-agents take.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool, query } from '../../db/client.js';
import { writeUnifiedMemory, updateTask, resolveAgentId, searchKnowledgeBase, readUnifiedMemory } from '../../mcp/tools.js';
import { classifyTaskIntent, prompt } from '../../llm/client.js';
import { dispatch } from '../registry.js';
import type { EvalResult } from '../eval/index.js';

/**
 * ASBCP (Agent Schema Based Communication Protocol) — @asbcp/core
 *
 * Every task Alex dispatches to a sub-agent is now a validated TaskMessage.
 * The SDK enforces the two-layer schema contract at the type level:
 *   - TaskMessage.intent  = sacred intent layer (set once, never modified)
 *   - TaskMessage.enrichment = Alex's context block (additive only)
 *   - TaskMessage.routing = origin → destination, with return_to for result routing
 *
 * The `validate()` call before dispatch catches any construction errors
 * (missing required fields, wrong types) before the message reaches a sub-agent.
 * If validation fails, the task fails loudly rather than silently producing
 * a malformed message that the sub-agent would silently misparse.
 */
import {
  type TaskMessage,
  TaskMessageSchema,
  validate as validateASBCP,
  createEnvelope,
} from '@asbcp/core';

// ---------------------------------------------------------------------------
// Soul.md — Alex's identity and governing document
// ---------------------------------------------------------------------------

/**
 * Path to SOUL.md, resolved relative to this module file.
 *
 * We use import.meta.url (ESM) rather than __dirname (CJS) because the repo
 * runs under ts-node/esm. `fileURLToPath` converts the file:// URL to an
 * OS path; `dirname` strips the filename to give us the directory.
 *
 * In the Docker container the layout is:
 *   /app/src/agents/alex/index.ts  ← this file
 *   /app/src/agents/alex/SOUL.md   ← identity document
 * so `join(__dirname, 'SOUL.md')` resolves correctly in both dev and prod.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SOUL_PATH = join(__dirname, 'SOUL.md');

/**
 * Alex's identity document, loaded once at module initialisation.
 *
 * SOUL.md is the highest governing document in Alex's decision stack.
 * It is read in full — never chunked, never summarised, never RAG'd —
 * because Alex's identity is a foundation, not a retrieval problem.
 * It must be present before any task runs.
 *
 * This variable is set by loadSoul() during runAlex() startup and is then
 * available for injection into system prompts for the lifetime of the process.
 * If the file cannot be read, Alex logs a warning and continues with a
 * minimal identity stub — a missing Soul.md is not fatal, but it is
 * logged as a high-importance event so it cannot be silently ignored.
 */
let SOUL: string | null = null;

/**
 * Read SOUL.md synchronously from disk and return its text.
 *
 * Synchronous read is intentional here: Soul.md must be fully loaded before
 * any heartbeat or LLM call is allowed to run. An async read would require
 * propagating a Promise through the entire startup sequence and could allow
 * a heartbeat to fire before identity is established. The synchronous call
 * blocks for < 1ms on a local SSD and is the correct trade-off at startup.
 *
 * @returns The full text of SOUL.md, or null if the file cannot be read.
 */
function loadSoul(): string | null {
  try {
    const text = readFileSync(SOUL_PATH, 'utf-8');
    console.log(`[Alex] Soul.md loaded (${text.length} chars) from ${SOUL_PATH}`);
    return text;
  } catch (err) {
    // Warn loudly but do not crash — Alex can operate without Soul.md but this
    // state should never persist. The missing-soul event is written to
    // unified_memory at importance=5 so it surfaces immediately in dashboards.
    console.error(`[Alex] WARNING: Could not read Soul.md at ${SOUL_PATH}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** How often Alex wakes up to poll, check delegations, and consolidate memory. */
const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute

/** Memories older than this many days with importance ≤ 2 are eligible for consolidation. */
const CONSOLIDATION_AGE_DAYS = 7;

/** Max number of memories compressed in a single consolidation pass. */
const CONSOLIDATION_BATCH = 50;

/**
 * Max wall-clock time (ms) before Alex gives up on a delegated sub-task.
 * When this elapses, the child task and parent task are both marked failed
 * and a system_alert is written to unified_memory.
 * Env var: EVAL_POLL_TIMEOUT_MS (default 30 minutes).
 */
const DISPATCH_TIMEOUT_MS = parseInt(process.env['EVAL_POLL_TIMEOUT_MS'] ?? '1800000');

/**
 * Base URL of the eval HTTP microservice (trustcore-eval container).
 * Alex POSTs to /eval after each sub-task completes to score the result.
 * Env var: EVAL_SERVICE_URL (default http://localhost:3005).
 */
const EVAL_SERVICE_URL = (process.env['EVAL_SERVICE_URL'] ?? 'http://localhost:3005').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Alex main loop
// ---------------------------------------------------------------------------

/**
 * Entry point — starts the Alex agent.
 * Writes a startup event to unified_memory, fires an immediate heartbeat,
 * then schedules recurring heartbeats every HEARTBEAT_INTERVAL_MS.
 * Registers a SIGINT handler for graceful shutdown.
 */
export async function runAlex(): Promise<void> {
  console.log('[Alex] Starting up...');

  // ---------------------------------------------------------------------------
  // Step 1: Load Soul.md — identity must be established before anything else.
  //
  // Soul.md is the highest governing document in Alex's decision stack. Loading
  // it first ensures that no heartbeat, task, or LLM call runs without Alex's
  // identity being present. The loaded text is stored in the module-level SOUL
  // variable, making it available for system prompt injection throughout the
  // process lifetime.
  //
  // After loading, we write the full Soul.md text to unified_memory so that:
  //   (a) It appears in the Mission Control activity feed at startup, confirming
  //       which version of Soul.md is active in the running process.
  //   (b) It is searchable via readUnifiedMemory() — Alex can reference his own
  //       identity document during enrichment and reasoning steps.
  //   (c) Any operator monitoring the system can confirm Soul.md loaded correctly
  //       and which version is governing this session.
  //
  // Importance=5 for the missing-soul alert (never silently ignore a missing
  // identity document). Importance=4 for the successful load (higher than normal
  // observations — this is a session boundary event).
  // ---------------------------------------------------------------------------
  SOUL = loadSoul();

  try {
    if (SOUL) {
      await writeUnifiedMemory(
        'alex',
        'observation',
        'Alex Soul.md loaded — identity established',
        {
          soul_path: SOUL_PATH,
          soul_length_chars: SOUL.length,
          loaded_at: new Date().toISOString(),
          // Store the full text so it's searchable in unified_memory. This is
          // intentionally verbose — Soul.md is a short document and must be
          // present in full, not summarised.
          soul_text: SOUL,
        },
        4
      );
      console.log('[Alex] Soul.md written to unified memory');
    } else {
      // Soul.md failed to load — write a high-importance alert and continue.
      // Alex is functional without it but operating without his identity document
      // is an abnormal state that must be surfaced immediately.
      await writeUnifiedMemory(
        'alex',
        'observation',
        'WARNING: Alex Soul.md could not be loaded — operating without identity document',
        { soul_path: SOUL_PATH, error: 'File not found or unreadable' },
        5
      );
    }
  } catch (err) {
    console.error('[Alex] Failed to write Soul.md to unified memory:', err);
  }

  // ---------------------------------------------------------------------------
  // Step 2: Log the general startup event.
  // ---------------------------------------------------------------------------
  try {
    await writeUnifiedMemory(
      'alex',
      'observation',
      'Alex agent started',
      { message: `Alex chief-of-staff initialized at ${new Date().toISOString()}` },
      3
    );
    console.log('[Alex] Logged startup event to unified memory');
  } catch (err) {
    console.error('[Alex] Failed to write startup event:', err);
  }
  console.log('[Alex] Entering heartbeat loop (every 60s)');

  // Run one heartbeat immediately, then schedule recurring
  await heartbeat();

  const interval = setInterval(async () => {
    try {
      await heartbeat();
    } catch (err) {
      console.error('[Alex] Heartbeat error:', err);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Alex] Shutting down...');
    clearInterval(interval);
    await writeUnifiedMemory(
      'alex',
      'observation',
      'Alex agent stopped gracefully',
      { message: `Alex shut down at ${new Date().toISOString()}` },
      2
    );
    await pool.end();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Heartbeat: pulse + poll pending + check completed delegations + consolidate
// ---------------------------------------------------------------------------

/**
 * Single heartbeat tick. Writes a heartbeat event to unified_memory
 * (so Alex appears alive in the Team sidebar), then runs all three
 * maintenance jobs in sequence. Errors in individual jobs are caught
 * and logged without aborting the rest of the tick.
 */
async function heartbeat(): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`[Alex] Heartbeat at ${ts}`);

  try {
    await writeUnifiedMemory(
      'alex',
      'heartbeat',
      `Alex heartbeat — system alive at ${ts}`,
      { ts, agent: 'alex' },
      1
    );
  } catch (err) {
    console.error('[Alex] Failed to write heartbeat to unified_memory:', err);
  }

  await pollPendingTasks();
  await checkCompletedDelegations();
  await consolidateOldMemories();
}

// ---------------------------------------------------------------------------
// Poll pending tasks assigned to Alex — dispatch only, do not block
// ---------------------------------------------------------------------------

/**
 * Find pending tasks assigned to Alex (or unassigned) and orchestrate each one.
 * Processes up to 10 tasks per heartbeat to bound loop time.
 * Each task is immediately marked in_progress so the next heartbeat doesn't
 * double-dispatch it before orchestration completes.
 */
async function pollPendingTasks(): Promise<void> {
  const result = await query<{
    id: string;
    title: string;
    description: string | null;
    status: string;
  }>(
    `SELECT t.id, t.title, t.description, t.status
     FROM tasks t
     LEFT JOIN agents a ON a.id = t.assigned_to_agent_id
     WHERE (a.slug = 'alex' OR t.assigned_to_agent_id IS NULL)
       AND t.status = 'pending'
     ORDER BY t.created_at ASC
     LIMIT 10`
  );

  if (result.rows.length === 0) return;

  console.log(`[Alex] Found ${result.rows.length} pending task(s)`);

  for (const task of result.rows) {
    console.log(`[Alex] Processing task: ${task.title} (${task.id})`);

    await updateTask(task.id, 'in_progress');
    await orchestrateTask(task);
  }
}

// ---------------------------------------------------------------------------
// Orchestrate a task: classify intent → handle directly or dispatch async
// ---------------------------------------------------------------------------

/**
 * Classify a task's intent and either handle it directly or delegate
 * asynchronously to a specialist sub-agent.
 *
 * Routing logic:
 *   1. LLM classification (qwen2.5:14b) — returns 'email-writer', 'research', or 'alex'
 *   2. Keyword fallback when Ollama is unavailable
 *
 * If targetAgent === 'alex': handled in-process with a single LLM prompt, task completed immediately.
 * Otherwise: dispatch() creates a child task in the DB, parent stays in_progress.
 * checkCompletedDelegations() picks up the result on the next heartbeat.
 */
async function orchestrateTask(task: {
  id: string;
  title: string;
  description: string | null;
}): Promise<void> {
  // 1. Try LLM-based classification first
  let targetAgent = await classifyTaskIntent(task.title, task.description);

  // 2. Fallback: keyword heuristic when Ollama is unavailable
  if (!targetAgent) {
    const text = `${task.title} ${task.description ?? ''}`.toLowerCase();
    const emailKeywords = ['email', 'write an email', 'draft', 'message', 'compose', 'correspondence'];
    const researchKeywords = ['research', 'look up', 'find', 'search', 'what is', 'how does', 'explain', 'retrieve'];
    if (emailKeywords.some((kw) => text.includes(kw))) {
      targetAgent = 'email-writer';
    } else if (researchKeywords.some((kw) => text.includes(kw))) {
      targetAgent = 'research';
    } else {
      targetAgent = 'alex';
    }
    console.log(`[Alex] LLM unavailable — keyword fallback: routed to '${targetAgent}'`);
  } else {
    console.log(`[Alex] LLM classified task as '${targetAgent}'`);
  }

  // 3a. Alex handles directly — synchronous (fast, just one LLM call)
  if (targetAgent === 'alex') {
    // Prepend Soul.md to the system prompt when Alex responds directly.
    // This ensures his identity and values govern every direct response, not
    // just his orchestration behaviour. If Soul.md is unavailable, fall back
    // to the minimal identity string — never send a prompt with no identity.
    const systemPrompt = SOUL
      ? `${SOUL}\n\n---\n\nYou are Alex, an AI chief-of-staff. Be concise and actionable.`
      : 'You are Alex, an AI chief-of-staff. Be concise and actionable.';

    const reply = await prompt(
      `Complete this task concisely: "${task.title}"${task.description ? `\n\nDetails: ${task.description}` : ''}`,
      systemPrompt
    );

    const taskResult = reply
      ? { answer: reply, source: 'llm' }
      : { answer: 'Task acknowledged. No LLM available for response.', source: 'heuristic' };

    await updateTask(task.id, 'completed', taskResult);
    await writeUnifiedMemory(
      'alex',
      'task_completed',
      `Alex completed task: ${task.title}`,
      { task_id: task.id, ...taskResult },
      3
    );
    return;
  }

  // TRUSTCORE STANDARD: All tasks use two-layer schema.
  // Intent layer = sacred, set by user/system, never modified.
  // Enrichment layer = Alex only, appended before dispatch.
  // This is SOP for all task types. Do not bypass.

  // 3b. Delegate to sub-agent — dispatch and record, do NOT block waiting for result.
  //     checkCompletedDelegations() in the next heartbeat handles follow-through.
  try {
    // Double-dispatch guard: if the target agent already has an in_progress sub-task,
    // two tasks would compete for the same Ollama slot on gpu0, which causes model
    // thrashing and degraded output quality. Instead, revert this parent task back
    // to pending and let the next heartbeat retry when the agent is free.
    const agentBusy = await guardAgentBusy(task.id, targetAgent);
    if (agentBusy) {
      // Revert parent to pending — will be picked up on next heartbeat poll.
      await updateTask(task.id, 'pending');
      console.log(`[Alex] ${targetAgent} is busy — deferred "${task.title}" to next heartbeat`);
      return;
    }

    // Build intent schema for all task types, then enrich before dispatch.
    let intentSchema: Record<string, unknown>;
    if (targetAgent === 'email-writer') {
      intentSchema = await buildEmailSchema(task.title, task.description);
    } else {
      intentSchema = buildGenericSchema(targetAgent, task.title, task.description);
    }

    // Enrich: Alex reasons about context (KB + memory) and appends enrichment block.
    const enrichedSchema = await enrichTask(intentSchema, task.title, task.id);

    // Build a validated ASBCP TaskMessage from the enriched schema.
    // This is the canonical dispatch envelope — intent + enrichment + routing,
    // validated by the SDK before any bytes hit the task queue.
    const asbcpMessage = buildTaskMessage(targetAgent, task.title, enrichedSchema);

    // Serialise the validated message as the sub-task description.
    // The sub-agent will JSON.parse this and detect the asbcp_version field.
    const subTaskDescription = JSON.stringify(asbcpMessage);

    // Log structured task_started — the full ASBCP message, not flat prose.
    // Stored in unified_memory with the message_id for cross-system correlation.
    await writeUnifiedMemory(
      'alex',
      'task_started',
      `Alex started task: ${task.title}`,
      {
        task_id: task.id,
        target_agent: targetAgent,
        asbcp_message_id: asbcpMessage.message_id,
        schema: enrichedSchema,
      },
      3
    );

    const { subTaskId } = await dispatch(
      'alex',
      task.id,
      targetAgent,
      task.title,
      subTaskDescription
    );

    // Record delegation metadata in the parent task result.
    // asbcp_message_id lets heartbeat and eval correlate this dispatch
    // with logs, memory events, and any downstream ASBCP responses.
    // schema is stored here so checkCompletedDelegations can pass it to eval.
    await updateTask(task.id, 'in_progress', {
      delegated_to: targetAgent,
      sub_task_id: subTaskId,
      dispatched_at: new Date().toISOString(),
      asbcp_message_id: asbcpMessage.message_id,
      schema: enrichedSchema,
    });

    console.log(`[Alex] Dispatched "${task.title}" → ${targetAgent} (sub-task ${subTaskId}) — async, will check on heartbeat`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Alex] Delegation failed: ${message}`);
    await updateTask(task.id, 'failed', { error: message });
    await writeUnifiedMemory(
      'alex',
      'task_failed',
      `Alex failed to delegate: ${task.title}`,
      { task_id: task.id, error: message },
      4
    );
  }
}

// ---------------------------------------------------------------------------
// Double-dispatch guard — prevent competing tasks on the same Ollama slot
// ---------------------------------------------------------------------------

/**
 * Returns true if the named sub-agent already has an in_progress task,
 * meaning its Ollama slot on gpu0 is still occupied.
 *
 * Why this matters:
 *   email-writer and eval both run on ollama-gpu0 (qwen2.5:7b). GPU 0 has
 *   OLLAMA_MAX_LOADED_MODELS=8 and OLLAMA_KEEP_ALIVE=0, but if two tasks
 *   are dispatched before the first one's keep_alive=0 has taken effect,
 *   both try to load the model simultaneously. This causes VRAM contention,
 *   slower completions, and occasionally OOM errors.
 *
 *   The fix: Alex checks for an existing in_progress sub-task before creating
 *   a new one. If one exists, Alex reverts the parent task to pending and
 *   retries on the next heartbeat (60s later), by which time the first task
 *   will have completed and the model will have been unloaded (keep_alive=0).
 *
 * @param parentTaskId - The parent task being processed (excluded from the check
 *                       to avoid false positives if this parent somehow has an
 *                       old in_progress child from a previous dispatch attempt)
 * @param agentSlug    - The sub-agent slug to check ('email-writer', 'research', etc.)
 * @returns true if the agent is busy and dispatch should be deferred
 */
async function guardAgentBusy(parentTaskId: string, agentSlug: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    `SELECT t.id
     FROM tasks t
     JOIN agents a ON a.id = t.assigned_to_agent_id
     WHERE a.slug = $1
       AND t.status = 'in_progress'
       AND t.parent_task_id IS DISTINCT FROM $2
     LIMIT 1`,
    [agentSlug, parentTaskId]
  );

  if (result.rows.length > 0) {
    await writeUnifiedMemory(
      'alex',
      'observation',
      `Alex deferred dispatch to ${agentSlug} — agent busy (task ${result.rows[0]!.id} in progress)`,
      {
        deferred_parent_id: parentTaskId,
        blocking_task_id: result.rows[0]!.id,
        agent: agentSlug,
      },
      2
    );
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Build a structured email schema from task context
// ---------------------------------------------------------------------------

/**
 * Use the LLM to extract structured email context from the task title + description.
 * Falls back to sensible defaults when the LLM is unavailable or extraction fails.
 * The schema is passed to the email-writer as its task description (JSON string),
 * and forwarded to the eval agent so it can score against the email-outreach rubric.
 */
async function buildEmailSchema(
  title: string,
  description: string | null
): Promise<Record<string, unknown>> {
  let extracted: Record<string, string> = {};

  const llmResult = await prompt(
    `Extract structured email context from this task. Return ONLY valid JSON, no prose, no markdown.

Task: "${title}"
${description ? `Details: ${description}` : ''}

Return JSON with these exact keys:
{
  "recipient_name": "<full name if mentioned, else empty string>",
  "recipient_role": "<job title/role if mentioned, else empty string>",
  "recipient_company": "<company name if mentioned, else empty string>",
  "relationship": "<cold|warm|existing — infer from context, default cold>",
  "context": "<any relevant context about the recipient or situation>",
  "goal": "<what this email is trying to achieve in one sentence>",
  "tone": "<professional|friendly|formal — infer from context, default professional>",
  "length": "<under 150 words|under 200 words|under 300 words — infer from context, default under 200 words>"
}`,
    'You are a data extraction assistant. Return only valid JSON with the exact keys requested, nothing else.'
  );

  if (llmResult) {
    try {
      const match = llmResult.match(/\{[\s\S]*\}/);
      if (match) extracted = JSON.parse(match[0]) as Record<string, string>;
    } catch {
      // LLM returned non-JSON — fall through to defaults
    }
  }

  return {
    type: 'email-outreach',
    recipient: {
      name: extracted['recipient_name'] ?? '',
      role: extracted['recipient_role'] ?? '',
      company: extracted['recipient_company'] ?? '',
      relationship: extracted['relationship'] ?? 'cold',
      context: extracted['context'] ?? (description ?? ''),
    },
    goal: extracted['goal'] ?? title,
    tone: extracted['tone'] ?? 'professional',
    length: extracted['length'] ?? 'under 200 words',
    constraints: [] as string[],
    eval: { type: 'email-outreach', priority: 'high' },
  };
}

// ---------------------------------------------------------------------------
// Build a generic task schema for non-email task types
// ---------------------------------------------------------------------------

/**
 * Builds a minimal intent schema for research, analysis, and other task types.
 * Keeps the same shape as email-outreach so enrichTask() works uniformly.
 */
function buildGenericSchema(
  taskType: string,
  title: string,
  description: string | null
): Record<string, unknown> {
  return {
    type: taskType,
    title,
    description: description ?? '',
    constraints: [] as string[],
  };
}

// ---------------------------------------------------------------------------
// Build a validated ASBCP TaskMessage from an enriched schema
// ---------------------------------------------------------------------------

/**
 * Assembles and validates an ASBCP TaskMessage from the enriched schema
 * produced by enrichTask(). This is the canonical dispatch envelope — every
 * sub-agent task passes through this function before hitting the task queue.
 *
 * Field mapping:
 *
 *   INTENT LAYER (sacred — from the enriched schema's intent fields)
 *     intent.type        ← enrichedSchema.type  (e.g. 'email-outreach')
 *     intent.payload     ← all task-type-specific fields (recipient, goal, etc.)
 *     intent.priority    ← always 'high' for now; future: derived from task metadata
 *     intent.constraints ← enrichedSchema.constraints array
 *     intent.eval_type   ← enrichedSchema.eval?.type if present
 *
 *   ENRICHMENT LAYER (additive — from enrichTask()'s output)
 *     enrichment.added_by        ← 'alex'
 *     enrichment.timestamp       ← ISO timestamp from enrichTask()
 *     enrichment.notes           ← Alex's strategic notes for the sub-agent
 *     enrichment.context_sources ← KB UUIDs + memory + LLM provenance trail
 *
 *   ROUTING HEADER
 *     routing.origin        ← 'alex' (always the dispatcher)
 *     routing.destination   ← the target sub-agent slug
 *     routing.dispatched_at ← current ISO timestamp
 *     routing.return_to     ← 'alex' (results always route back here)
 *
 * The message is validated with validate() before this function returns.
 * A ZodError here indicates a construction bug — callers should treat it as fatal.
 *
 * @param targetAgent - Slug of the destination sub-agent ('email-writer', 'research', etc.)
 * @param taskTitle - Human-readable title from the parent task
 * @param enrichedSchema - Output of enrichTask() — intent fields + enrichment block
 * @returns A validated TaskMessage ready for serialisation into task.description
 */
function buildTaskMessage(
  targetAgent: string,
  taskTitle: string,
  enrichedSchema: Record<string, unknown>
): TaskMessage {
  // --- Separate intent fields from the enrichment block ---
  // The enrichment block was appended by enrichTask() at the top level.
  // Extract it, then use the remaining fields as the intent payload.
  const { enrichment: enrichmentBlock, ...intentFields } = enrichedSchema;

  // --- Assemble intent.payload ---
  // For email-outreach: the full schema minus the enrichment block IS the payload.
  // For generic tasks: payload carries the title and free-text description.
  // In both cases we omit the protocol-level fields (type, constraints, eval)
  // that live as dedicated intent properties, keeping payload as task-specific data.
  const { type, constraints, eval: evalBlock, ...payloadFields } = intentFields as Record<string, unknown>;

  // --- Build the envelope + intent + enrichment + routing ---
  const envelope = createEnvelope('task', crypto.randomUUID());

  const raw: unknown = {
    ...envelope,
    intent: {
      // task type — dot-notation, matches the sub-agent's `accepts` list
      type: (type as string) ?? targetAgent,

      // task-specific data: recipient, goal, tone, length, etc.
      payload: {
        title: taskTitle,
        ...payloadFields,
      },

      // all dispatched tasks are high-priority for now
      priority: 'high',

      // hard constraints from the intent layer — sub-agent must not violate these
      constraints: Array.isArray(constraints) ? constraints : [],

      // eval type — tells the eval agent which rubric to apply
      eval_type: (evalBlock as Record<string, unknown> | undefined)?.['type'] as string | undefined,
    },

    // enrichment block — Alex's strategic notes, KB sources, and provenance trail
    enrichment: enrichmentBlock
      ? {
          added_by: (enrichmentBlock as Record<string, unknown>)['added_by'] as string,
          timestamp: (enrichmentBlock as Record<string, unknown>)['timestamp'] as string,
          notes: (enrichmentBlock as Record<string, unknown>)['notes'] as string,
          context_sources: (enrichmentBlock as Record<string, unknown>)['context_sources'] as string[],
        }
      : undefined,

    // routing header — origin → destination, results return to alex
    routing: {
      origin: 'alex',
      destination: targetAgent,
      dispatched_at: new Date().toISOString(),
      return_to: 'alex',
    },
  };

  // --- Validate the assembled message against the ASBCP TaskMessageSchema ---
  // This catches construction errors (wrong types, missing fields) at dispatch time,
  // not at execution time inside the sub-agent. Fail loudly here.
  const result = validateASBCP(raw);
  if (!result.success) {
    const issues = result.error.flatten().fieldErrors;
    throw new Error(
      `ASBCP validation failed for task to '${targetAgent}': ${JSON.stringify(issues)}`
    );
  }

  // TypeScript now knows result.data is a valid TaskMessage
  return result.data as TaskMessage;
}

// ---------------------------------------------------------------------------
// Enrich a task schema with Alex's strategic context (two-layer schema SOP)
// ---------------------------------------------------------------------------

/**
 * Enrichment step — Alex reads KB entries and recent memory observations,
 * then uses the LLM to generate strategic notes before dispatch.
 * Appends an immutable enrichment block to the intent schema:
 *   { added_by: 'alex', timestamp, notes, context_sources }
 *
 * The intent layer is NEVER modified — enrichment is always additive.
 */
async function enrichTask(
  intentSchema: Record<string, unknown>,
  taskTitle: string,
  taskId: string
): Promise<Record<string, unknown>> {
  const contextSources: string[] = [];
  const contextParts: string[] = [];

  // 1. Search KB for relevant entries
  try {
    const kbResults = await searchKnowledgeBase(taskTitle, 'alex', 3);
    if (kbResults.length > 0) {
      contextParts.push(
        'KB context:\n' + kbResults.map((r) => `- ${r.content}`).join('\n')
      );
      contextSources.push(...kbResults.map((r) => `kb:${r.id}`));
    }
  } catch (err) {
    console.error('[Alex] enrichTask KB search failed:', err instanceof Error ? err.message : String(err));
  }

  // 2. Read recent unified_memory observations for strategic context
  try {
    const recentMems = await readUnifiedMemory(taskTitle, { limit: 5, event_type: 'observation' });
    if (recentMems.length > 0) {
      contextParts.push(
        'Recent observations:\n' + recentMems.map((m) => `- ${m.summary}`).join('\n')
      );
      contextSources.push('unified_memory:recent_observations');
    }
  } catch (err) {
    console.error('[Alex] enrichTask memory read failed:', err instanceof Error ? err.message : String(err));
  }

  // 3. LLM generates strategic notes for the sub-agent
  let notes = 'No additional context available.';
  if (contextParts.length > 0) {
    const contextBlock = contextParts.join('\n\n');
    const schemaStr = JSON.stringify(intentSchema, null, 2);
    const llmNotes = await prompt(
      `You are Alex, a chief-of-staff AI. A sub-agent is about to work on this task:

Task: "${taskTitle}"
Schema: ${schemaStr}

Available context:
${contextBlock}

In 2-3 sentences, write strategic notes for the sub-agent: what context is most relevant, any nuances to be aware of, and what success looks like. Be specific and actionable, not generic.`,
      'You are Alex. Write concise strategic notes for a sub-agent. No preamble, just the notes.'
    );
    if (llmNotes) {
      notes = llmNotes.trim();
      contextSources.push('llm:alex-strategic-reasoning');
    }
  }

  console.log(`[Alex] Enriched task ${taskId}: ${contextSources.length} context sources`);

  return {
    ...intentSchema,
    enrichment: {
      added_by: 'alex',
      timestamp: new Date().toISOString(),
      notes,
      context_sources: contextSources,
    },
  };
}

// ---------------------------------------------------------------------------
// Check completed delegations — called every heartbeat.
// Finds in_progress parent tasks whose child sub-task has reached a terminal
// state, runs eval on successful results, and marks the parent done.
// Also enforces DISPATCH_TIMEOUT_MS for stuck sub-tasks.
// ---------------------------------------------------------------------------

async function checkCompletedDelegations(): Promise<void> {
  // --- Find parents with a terminal child ---
  const completed = await query<{
    parent_id: string;
    parent_title: string;
    parent_description: string | null;
    parent_result: Record<string, unknown> | null;
    child_id: string;
    child_status: string;
    child_result: unknown;
    producer_slug: string | null;
  }>(`
    SELECT
      t.id          AS parent_id,
      t.title       AS parent_title,
      t.description AS parent_description,
      t.result      AS parent_result,
      c.id          AS child_id,
      c.status      AS child_status,
      c.result      AS child_result,
      ag.slug       AS producer_slug
    FROM tasks t
    JOIN tasks c ON c.parent_task_id = t.id
    LEFT JOIN agents ta ON ta.id = t.assigned_to_agent_id
    LEFT JOIN agents ag ON ag.id = c.assigned_to_agent_id
    WHERE t.status = 'in_progress'
      AND (ta.slug = 'alex' OR t.assigned_to_agent_id IS NULL)
      AND c.status IN ('completed', 'failed')
    ORDER BY t.created_at ASC
  `);

  for (const row of completed.rows) {
    console.log(`[Alex] Sub-task ${row.child_id} finished with status '${row.child_status}' — processing parent ${row.parent_id}`);

    if (row.child_status === 'failed') {
      // Sub-agent failed — propagate failure to parent
      await updateTask(row.parent_id, 'failed', {
        delegated_to: row.producer_slug,
        sub_task_id: row.child_id,
        sub_status: 'failed',
      });
      await writeUnifiedMemory(
        'alex',
        'task_failed',
        `Delegated task failed: ${row.parent_title}`,
        { task_id: row.parent_id, sub_task_id: row.child_id, agent: row.producer_slug },
        4
      );
      continue;
    }

    // Sub-agent completed — run eval if result is present
    if (row.child_result) {
      try {
        // Extract schema stored during dispatch (for email-outreach rubric targeting)
        const schema = row.parent_result?.['schema'] as Record<string, unknown> | undefined;

        const evalResult = await callEvalService({
          taskId: row.child_id,
          taskTitle: row.parent_title,
          taskDescription: row.parent_description ?? null,
          producerAgentSlug: row.producer_slug ?? 'unknown',
          result: row.child_result,
          schema,
        });

        if (evalResult) {
          console.log(`[Alex] Eval: ${evalResult.composite_score.toFixed(2)} → ${evalResult.outcome}`);
          if (evalResult.outcome === 'needs_review') {
            console.log(`[Alex] Flagging task ${row.parent_id} for human review`);
            await writeUnifiedMemory(
              'alex',
              'observation',
              `Task flagged for review: ${row.parent_title} (score ${evalResult.composite_score.toFixed(2)})`,
              { task_id: row.parent_id, eval_id: evalResult.evalId, outcome: evalResult.outcome },
              4
            );
          }
        }
      } catch (err) {
        console.error(`[Alex] Eval failed (non-fatal):`, err instanceof Error ? err.message : String(err));
      }
    }

    await updateTask(row.parent_id, 'completed', {
      delegated_to: row.producer_slug,
      sub_task_id: row.child_id,
      sub_status: row.child_status,
    });

    await writeUnifiedMemory(
      'alex',
      'task_completed',
      `Alex delegated task completed: ${row.parent_title}`,
      { task_id: row.parent_id, sub_task_id: row.child_id, agent: row.producer_slug },
      2
    );
  }

  // --- Timeout check: in_progress parents with stuck (pending/in_progress) child ---
  const timeoutSeconds = Math.floor(DISPATCH_TIMEOUT_MS / 1000);
  const timedOut = await query<{
    parent_id: string;
    parent_title: string;
    child_id: string;
  }>(`
    SELECT
      t.id    AS parent_id,
      t.title AS parent_title,
      c.id    AS child_id
    FROM tasks t
    JOIN tasks c ON c.parent_task_id = t.id
    LEFT JOIN agents ta ON ta.id = t.assigned_to_agent_id
    WHERE t.status = 'in_progress'
      AND (ta.slug = 'alex' OR t.assigned_to_agent_id IS NULL)
      AND c.status IN ('pending', 'in_progress')
      AND t.updated_at < NOW() - make_interval(secs => $1)
  `, [timeoutSeconds]);

  for (const row of timedOut.rows) {
    console.log(`[Alex] Task timeout: "${row.parent_title}" — sub-task ${row.child_id} did not complete in ${timeoutSeconds}s`);

    await updateTask(row.child_id, 'failed', {
      error: 'timeout',
      message: 'Sub-task did not complete within dispatch timeout',
    });
    await updateTask(row.parent_id, 'failed', {
      error: 'timeout',
      sub_task_id: row.child_id,
    });
    await writeUnifiedMemory(
      'alex',
      'system_alert',
      `Task timeout: ${row.parent_title} — sub-agent did not complete in time`,
      { task_id: row.parent_id, sub_task_id: row.child_id, timeout_ms: DISPATCH_TIMEOUT_MS },
      5
    );
  }
}

// ---------------------------------------------------------------------------
// Call the eval HTTP service
// ---------------------------------------------------------------------------

interface EvalHttpInput {
  taskId: string;
  taskTitle: string;
  taskDescription: string | null;
  producerAgentSlug: string;
  result: unknown;
  revisionNumber?: number;
  previousEvalId?: string;
  schema?: Record<string, unknown>;
}

/**
 * POST the sub-task result to the eval HTTP service (trustcore-eval container).
 * The eval service runs qwen2.5:7b on GPU 0 to score the result across
 * 6 weighted dimensions and persists the score to eval_scores.
 *
 * Returns null on any failure (eval is non-fatal — the task still completes).
 * 5-minute timeout allows for model load time on GPU 0.
 */
async function callEvalService(input: EvalHttpInput): Promise<EvalResult | null> {
  try {
    const res = await fetch(`${EVAL_SERVICE_URL}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(300_000), // 5 min — eval can be slow on gpu0
    });

    if (!res.ok) {
      console.error(`[Alex] Eval service returned ${res.status}: ${await res.text()}`);
      return null;
    }

    return (await res.json()) as EvalResult;
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      console.error('[Alex] Eval service timed out');
    } else {
      console.error('[Alex] Eval service unavailable:', err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Consolidate old memories
// ---------------------------------------------------------------------------

/**
 * Compress old, low-importance unified_memory entries into a single summary.
 *
 * Selects up to CONSOLIDATION_BATCH memories older than CONSOLIDATION_AGE_DAYS
 * with importance ≤ 2 that haven't been consolidated yet. Uses qwen2.5:14b
 * to summarize them into 2-3 sentences, writes the summary as a new
 * 'consolidation_summary' event, records the consolidation in memory_consolidations,
 * and marks the originals as consolidated so they aren't processed again.
 *
 * This prevents unified_memory from growing unboundedly while preserving
 * the substance of historical events in a searchable summary.
 */
async function consolidateOldMemories(): Promise<void> {
  const result = await query<{ id: string; summary: string }>(
    `SELECT id, summary
     FROM unified_memory
     WHERE is_consolidated = false
       AND is_archived = false
       AND importance <= 2
       AND created_at < NOW() - INTERVAL '${CONSOLIDATION_AGE_DAYS} days'
     ORDER BY created_at ASC
     LIMIT $1`,
    [CONSOLIDATION_BATCH]
  );

  if (result.rows.length === 0) return;

  console.log(`[Alex] Consolidating ${result.rows.length} old memory entries`);

  const rows = result.rows as Array<{ id: string; summary: string }>;
  const bulletList = rows.map((r) => `- ${r.summary}`).join('\n');

  const llmDigest = await prompt(
    `Summarize these memory entries into 2-3 sentences:\n${bulletList}`,
    'You are an AI memory consolidation system. Be concise and factual.'
  );
  const summaryText = llmDigest ?? bulletList;

  const summaryMemory = await writeUnifiedMemory(
    'alex',
    'consolidation_summary',
    `Consolidated ${rows.length} old memories`,
    { summary: summaryText, memory_count: rows.length },
    3
  );

  const rangeResult = await query<{ min_ts: Date; max_ts: Date }>(
    `SELECT MIN(created_at) as min_ts, MAX(created_at) as max_ts
     FROM unified_memory
     WHERE id = ANY($1::uuid[])`,
    [rows.map((r) => r.id)]
  );

  const alexId = await resolveAgentId('alex');
  const range = rangeResult.rows[0];

  const consResult = await query<{ id: string }>(
    `INSERT INTO memory_consolidations
       (summary_memory_id, time_range_start, time_range_end, memory_count, agent_scope)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [summaryMemory.id, range?.min_ts ?? new Date(), range?.max_ts ?? new Date(), rows.length, alexId]
  );

  const consolidationId = consResult.rows[0]!.id;
  const ids = rows.map((r) => r.id);

  await query(
    `UPDATE unified_memory
     SET is_consolidated = true, consolidation_id = $1
     WHERE id = ANY($2::uuid[])`,
    [consolidationId, ids]
  );

  console.log(`[Alex] Consolidated ${ids.length} memories → ${consolidationId}`);
}
