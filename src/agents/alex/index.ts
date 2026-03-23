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

import { pool, query } from '../../db/client.js';
import { writeUnifiedMemory, updateTask, resolveAgentId, searchKnowledgeBase, readUnifiedMemory } from '../../mcp/tools.js';
import { classifyTaskIntent, prompt } from '../../llm/client.js';
import { dispatch } from '../registry.js';
import type { EvalResult } from '../eval/index.js';

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
    const reply = await prompt(
      `Complete this task concisely: "${task.title}"${task.description ? `\n\nDetails: ${task.description}` : ''}`,
      'You are Alex, an AI chief-of-staff. Be concise and actionable.'
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
    // Build intent schema for all task types, then enrich before dispatch.
    let intentSchema: Record<string, unknown>;
    if (targetAgent === 'email-writer') {
      intentSchema = await buildEmailSchema(task.title, task.description);
    } else {
      intentSchema = buildGenericSchema(targetAgent, task.title, task.description);
    }

    // Enrich: Alex reasons about context (KB + memory) and appends enrichment block.
    const enrichedSchema = await enrichTask(intentSchema, task.title, task.id);
    const subTaskDescription = JSON.stringify(enrichedSchema);

    // Log structured task_started — full schema + enrichment, not flat prose.
    await writeUnifiedMemory(
      'alex',
      'task_started',
      `Alex started task: ${task.title}`,
      {
        task_id: task.id,
        target_agent: targetAgent,
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

    // Record the delegation metadata in the parent task result so heartbeat
    // can find and process it without re-reading intermediate state.
    // schema is stored here so checkCompletedDelegations can pass it to eval.
    await updateTask(task.id, 'in_progress', {
      delegated_to: targetAgent,
      sub_task_id: subTaskId,
      dispatched_at: new Date().toISOString(),
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
