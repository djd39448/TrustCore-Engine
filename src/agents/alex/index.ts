import { pool, query } from '../../db/client.js';
import { writeUnifiedMemory, updateTask, resolveAgentId } from '../../mcp/tools.js';
import { classifyTaskIntent, prompt } from '../../llm/client.js';
import { dispatch } from '../registry.js';
import type { EvalResult } from '../eval/index.js';

const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute
const CONSOLIDATION_AGE_DAYS = 7;
const CONSOLIDATION_BATCH = 50;

// EVAL_POLL_TIMEOUT_MS is the max wall-clock time Alex waits for a delegated
// sub-task to reach terminal status before marking it failed.
const DISPATCH_TIMEOUT_MS = parseInt(process.env['EVAL_POLL_TIMEOUT_MS'] ?? '1800000');

// URL of the eval HTTP service (trustcore-eval container).
const EVAL_SERVICE_URL = (process.env['EVAL_SERVICE_URL'] ?? 'http://localhost:3005').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Alex main loop
// ---------------------------------------------------------------------------

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

    await writeUnifiedMemory(
      'alex',
      'task_started',
      `Alex started task: ${task.title}`,
      { task_id: task.id, description: task.description ?? 'none' },
      3
    );

    await orchestrateTask(task);
  }
}

// ---------------------------------------------------------------------------
// Orchestrate a task: classify intent → handle directly or dispatch async
// ---------------------------------------------------------------------------

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

  // 3b. Delegate to sub-agent — dispatch and record, do NOT block waiting for result.
  //     checkCompletedDelegations() in the next heartbeat handles follow-through.
  try {
    const { subTaskId } = await dispatch(
      'alex',
      task.id,
      targetAgent,
      task.title,
      task.description ?? undefined
    );

    // Record the delegation metadata in the parent task result so heartbeat
    // can find and process it without re-reading intermediate state.
    await updateTask(task.id, 'in_progress', {
      delegated_to: targetAgent,
      sub_task_id: subTaskId,
      dispatched_at: new Date().toISOString(),
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
    child_id: string;
    child_status: string;
    child_result: unknown;
    producer_slug: string | null;
  }>(`
    SELECT
      t.id          AS parent_id,
      t.title       AS parent_title,
      t.description AS parent_description,
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
        const evalResult = await callEvalService({
          taskId: row.child_id,
          taskTitle: row.parent_title,
          taskDescription: row.parent_description ?? null,
          producerAgentSlug: row.producer_slug ?? 'unknown',
          result: row.child_result,
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
}

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
