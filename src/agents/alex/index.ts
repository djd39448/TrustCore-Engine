import { pool, query } from '../../db/client.js';
import { writeUnifiedMemory, updateTask, resolveAgentId } from '../../mcp/tools.js';
import { classifyTaskIntent, prompt } from '../../llm/client.js';
import { dispatch } from '../registry.js';
import { evaluate } from '../eval/index.js';

const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute
const CONSOLIDATION_AGE_DAYS = 7;
const CONSOLIDATION_BATCH = 50;
const EVAL_POLL_TIMEOUT_MS = parseInt(process.env['EVAL_POLL_TIMEOUT_MS'] ?? '90000', 10);
const EVAL_POLL_INTERVAL_MS = 3_000;

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
// Heartbeat: poll pending tasks + consolidate old memories
// ---------------------------------------------------------------------------

async function heartbeat(): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`[Alex] Heartbeat at ${ts}`);

  // Write heartbeat event so the dashboard indicator stays green
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
  await consolidateOldMemories();
}

// ---------------------------------------------------------------------------
// Poll pending tasks assigned to Alex
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
// Orchestrate a task: classify intent → delegate to sub-agent or handle directly
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

  if (targetAgent === 'alex') {
    // Alex handles it directly — generate a summary via LLM if possible
    const reply = await prompt(
      `Complete this task concisely: "${task.title}"${task.description ? `\n\nDetails: ${task.description}` : ''}`,
      'You are Alex, an AI chief-of-staff. Be concise and actionable.'
    );

    const result = reply
      ? { answer: reply, source: 'llm' }
      : { answer: 'Task acknowledged. No LLM available for response.', source: 'heuristic' };

    await updateTask(task.id, 'completed', result);
    await writeUnifiedMemory(
      'alex',
      'task_completed',
      `Alex completed task: ${task.title}`,
      { task_id: task.id, ...result },
      3
    );
    return;
  }

  // Delegate to a sub-agent via the registry
  try {
    const { subTaskId } = await dispatch(
      'alex',
      task.id,
      targetAgent,
      task.title,
      task.description ?? undefined
    );

    console.log(`[Alex] Delegated '${task.title}' → ${targetAgent} (sub-task ${subTaskId})`);

    // Poll for sub-task completion (timeout via EVAL_POLL_TIMEOUT_MS)
    const maxPolls = Math.ceil(EVAL_POLL_TIMEOUT_MS / EVAL_POLL_INTERVAL_MS);
    let subStatus = 'pending';
    let subResult: unknown = null;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise<void>((r) => setTimeout(r, EVAL_POLL_INTERVAL_MS));
      const sub = await query<{ status: string; result: unknown }>(
        `SELECT status, result FROM tasks WHERE id = $1`,
        [subTaskId]
      );
      subStatus = sub.rows[0]?.status ?? 'pending';
      subResult = sub.rows[0]?.result ?? null;
      if (subStatus === 'completed' || subStatus === 'failed') break;
    }

    console.log(`[Alex] Sub-task ${subTaskId} finished with status: ${subStatus}`);

    // Run eval when sub-task completed successfully
    if (subStatus === 'completed' && subResult) {
      try {
        const evalResult = await evaluate({
          taskId: subTaskId,
          taskTitle: task.title,
          taskDescription: task.description,
          producerAgentSlug: targetAgent,
          result: subResult,
        });

        console.log(`[Alex] Eval: composite=${evalResult.composite_score} outcome=${evalResult.outcome}`);

        if (evalResult.outcome === 'needs_review' || evalResult.outcome === 'needs_revision') {
          await writeUnifiedMemory(
            'alex',
            'observation',
            `Eval flagged task for review: ${task.title}`,
            {
              task_id: subTaskId,
              eval_id: evalResult.evalId,
              composite: evalResult.composite_score,
              outcome: evalResult.outcome,
              suggestions: evalResult.improvement_suggestions,
            },
            4
          );
        }
      } catch (evalErr) {
        // Eval failure must never crash the agent loop
        console.error(`[Alex] Eval error (non-fatal):`, evalErr);
      }
    }

    // Mark the parent task completed
    await updateTask(task.id, 'completed', {
      delegated_to: targetAgent,
      sub_task_id: subTaskId,
      sub_status: subStatus,
    });

    await writeUnifiedMemory(
      'alex',
      'task_completed',
      `Alex delegated task to ${targetAgent}: ${task.title}`,
      { task_id: task.id, sub_task_id: subTaskId, sub_status: subStatus },
      2
    );
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
// Consolidate old memories
// Consolidation flow:
//   1. Write a consolidation_summary entry to unified_memory
//   2. Create a memory_consolidations record pointing to that entry
//   3. Mark source memories with consolidation_id
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

  // Try to get a LLM-generated digest; fall back to bullet list
  const llmDigest = await prompt(
    `Summarize these memory entries into 2-3 sentences:\n${bulletList}`,
    'You are an AI memory consolidation system. Be concise and factual.'
  );
  const summaryText = llmDigest ?? bulletList;

  // Step 1: Write the consolidation summary as a unified_memory entry
  const summaryMemory = await writeUnifiedMemory(
    'alex',
    'consolidation_summary',
    `Consolidated ${rows.length} old memories`,
    { summary: summaryText, memory_count: rows.length },
    3
  );

  // Step 2: Get time range of consolidated memories
  const rangeResult = await query<{ min_ts: Date; max_ts: Date }>(
    `SELECT MIN(created_at) as min_ts, MAX(created_at) as max_ts
     FROM unified_memory
     WHERE id = ANY($1::uuid[])`,
    [rows.map((r) => r.id)]
  );

  const alexId = await resolveAgentId('alex');
  const range = rangeResult.rows[0];

  // Step 3: Create memory_consolidations record
  const consResult = await query<{ id: string }>(
    `INSERT INTO memory_consolidations
       (summary_memory_id, time_range_start, time_range_end, memory_count, agent_scope)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [summaryMemory.id, range?.min_ts ?? new Date(), range?.max_ts ?? new Date(), rows.length, alexId]
  );

  const consolidationId = consResult.rows[0]!.id;
  const ids = rows.map((r) => r.id);

  // Step 4: Mark source memories as consolidated
  await query(
    `UPDATE unified_memory
     SET is_consolidated = true, consolidation_id = $1
     WHERE id = ANY($2::uuid[])`,
    [consolidationId, ids]
  );

  console.log(`[Alex] Consolidated ${ids.length} memories → ${consolidationId}`);
}
