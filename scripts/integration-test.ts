/**
 * integration-test.ts — End-to-end orchestration scenario.
 *
 * Scenario: "Write a welcome email for a new TrustCore user"
 *
 *   1. Create a task assigned to Alex
 *   2. Simulate Alex's orchestration loop: classify intent → dispatch to email-writer
 *   3. Simulate Email Writer completing the task
 *   4. Verify the full chain in DB:
 *        - Parent task: pending → in_progress → completed (delegated)
 *        - Child task: pending → in_progress → completed (with email draft)
 *        - unified_memory: task_started, agent_called, task_completed events
 *        - agent_memory: workflow_step entries from email-writer
 *   5. Print PASS/FAIL for each assertion
 *
 * This test does NOT require Ollama to be running — it stubs the LLM calls
 * and tests the full task lifecycle, memory writes, and DB state.
 *
 * Run: node --loader ts-node/esm scripts/integration-test.ts
 */

import { pool, query } from '../src/db/client.js';
import {
  createTask,
  updateTask,
  writeUnifiedMemory,
  writeOwnMemory,
  readUnifiedMemory,
} from '../src/mcp/tools.js';
import { dispatch } from '../src/agents/registry.js';

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed++;
}

function fail(name: string, err: unknown) {
  console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
  failed++;
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass(name);
  } catch (err) {
    fail(name, err);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

/**
 * Simulate Alex's orchestration of the welcome email task.
 * In production this runs inside alex/index.ts; here we replay the same
 * DB operations so we can assert on state without running the full loop.
 */
async function simulateAlex(parentTaskId: string, taskTitle: string): Promise<string> {
  // Alex marks the task in_progress
  await updateTask(parentTaskId, 'in_progress');
  await writeUnifiedMemory(
    'alex', 'task_started',
    `Alex started task: ${taskTitle}`,
    { task_id: parentTaskId },
    3
  );

  // Alex dispatches to email-writer via registry
  const { subTaskId } = await dispatch('alex', parentTaskId, 'email-writer', taskTitle,
    'Write a warm, professional welcome email. Include a getting-started tip.'
  );

  // Alex marks parent completed (delegated)
  await updateTask(parentTaskId, 'completed', { delegated_to: 'email-writer', sub_task_id: subTaskId });
  await writeUnifiedMemory(
    'alex', 'task_completed',
    `Alex delegated to email-writer: ${taskTitle}`,
    { task_id: parentTaskId, sub_task_id: subTaskId },
    2
  );

  return subTaskId;
}

/**
 * Simulate the Email Writer sub-agent picking up and completing the child task.
 * In production this runs inside email-writer/index.ts.
 */
async function simulateEmailWriter(subTaskId: string, taskTitle: string): Promise<void> {
  await updateTask(subTaskId, 'in_progress');
  await writeUnifiedMemory(
    'email-writer', 'task_started',
    `Email Writer started: ${taskTitle}`,
    { task_id: subTaskId },
    3
  );

  // Log workflow steps to agent_memory
  await writeOwnMemory('email-writer', 'workflow_step', 'Research step: searched KB', { step: 1, kb_hits: 0 });
  await writeOwnMemory('email-writer', 'workflow_step', 'Draft step: composed email', { step: 2 });
  await writeOwnMemory('email-writer', 'workflow_step', 'Review step: self-critiqued draft', { step: 3 });

  // Return the completed draft (stub — no LLM needed for test)
  const draft = {
    subject: 'Welcome to TrustCore!',
    body: [
      'Hi there,',
      '',
      'Welcome to TrustCore — your locally-hosted AI agent platform.',
      '',
      'Getting started tip: run `docker compose up -d` to start the full stack,',
      'then visit http://localhost:3000 for the Mission Control dashboard.',
      '',
      'The TrustCore Team',
    ].join('\n'),
    model: 'stub (integration test)',
    kb_context_used: false,
    reviewed: false,
  };

  await updateTask(subTaskId, 'completed', draft);
  await writeUnifiedMemory(
    'email-writer', 'task_completed',
    `Email Writer completed: ${taskTitle}`,
    { task_id: subTaskId, subject: draft.subject },
    3
  );
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

async function assertTaskStatus(
  taskId: string,
  expectedStatus: string,
  label: string
): Promise<void> {
  const row = await query<{ status: string; started_at: Date | null; completed_at: Date | null }>(
    'SELECT status, started_at, completed_at FROM tasks WHERE id = $1',
    [taskId]
  );
  assert(row.rows.length > 0, `task ${taskId} not found`);
  assert(row.rows[0]!.status === expectedStatus, `${label}: expected ${expectedStatus}, got ${row.rows[0]!.status}`);
}

async function assertUnifiedMemoryEvent(
  agentSlug: string,
  eventType: string,
  minCount: number,
  label: string
): Promise<void> {
  const result = await query<{ cnt: string }>(
    `SELECT COUNT(*) as cnt FROM unified_memory um
     JOIN agents a ON a.id = um.author_agent_id
     WHERE a.slug = $1 AND um.event_type = $2`,
    [agentSlug, eventType]
  );
  const count = parseInt(result.rows[0]!.cnt, 10);
  assert(count >= minCount, `${label}: expected >= ${minCount} '${eventType}' events from ${agentSlug}, got ${count}`);
}

async function assertAgentMemorySteps(agentSlug: string, minSteps: number, label: string) {
  const result = await query<{ cnt: string }>(
    `SELECT COUNT(*) as cnt FROM agent_memory am
     JOIN agents a ON a.id = am.agent_id
     WHERE a.slug = $1 AND am.memory_type = 'workflow_step'`,
    [agentSlug]
  );
  const count = parseInt(result.rows[0]!.cnt, 10);
  assert(count >= minSteps, `${label}: expected >= ${minSteps} workflow_step entries from ${agentSlug}, got ${count}`);
}

// ---------------------------------------------------------------------------
// Run the integration test
// ---------------------------------------------------------------------------

async function main() {
  console.log('TrustCore Engine — Integration Test');
  console.log('Scenario: "Write a welcome email for a new TrustCore user"');
  console.log('====================================================');

  const TASK_TITLE = 'Write a welcome email for a new TrustCore user';
  let parentTaskId: string | undefined;
  let subTaskId: string | undefined;

  // ── Step 1: Create the initial task ─────────────────────────────────────
  console.log('\n[Step 1] Create task assigned to Alex');
  await test('createTask returns UUID', async () => {
    const result = await createTask('system', TASK_TITLE,
      'Write a warm, professional welcome email.', 'alex');
    assert(typeof result.id === 'string', 'expected UUID');
    parentTaskId = result.id;
  });

  await test('parent task starts as pending', async () => {
    await assertTaskStatus(parentTaskId!, 'pending', 'parent task');
  });

  // ── Step 2: Alex orchestrates ────────────────────────────────────────────
  console.log('\n[Step 2] Alex orchestrates → dispatches to email-writer');
  await test('Alex orchestration runs without error', async () => {
    subTaskId = await simulateAlex(parentTaskId!, TASK_TITLE);
    assert(typeof subTaskId === 'string', 'expected sub-task UUID');
  });

  await test('parent task is completed after delegation', async () => {
    await assertTaskStatus(parentTaskId!, 'completed', 'parent after delegation');
  });

  await test('child task created as pending for email-writer', async () => {
    await assertTaskStatus(subTaskId!, 'pending', 'child task');
  });

  await test('agent_called event written to unified_memory', async () => {
    await assertUnifiedMemoryEvent('alex', 'agent_called', 1, 'alex agent_called');
  });

  // ── Step 3: Email Writer picks up and completes ───────────────────────────
  console.log('\n[Step 3] Email Writer processes and completes the task');
  await test('Email Writer runs without error', async () => {
    await simulateEmailWriter(subTaskId!, TASK_TITLE);
  });

  await test('child task is completed', async () => {
    await assertTaskStatus(subTaskId!, 'completed', 'child task completed');
    // Verify started_at and completed_at both set
    const row = await query<{ started_at: Date | null; completed_at: Date | null; result: unknown }>(
      'SELECT started_at, completed_at, result FROM tasks WHERE id = $1',
      [subTaskId]
    );
    assert(row.rows[0]!.started_at !== null, 'started_at should be set');
    assert(row.rows[0]!.completed_at !== null, 'completed_at should be set');
  });

  // ── Step 4: Verify unified_memory chain ──────────────────────────────────
  console.log('\n[Step 4] Verify unified_memory chain');
  await test('alex wrote task_started event', async () => {
    await assertUnifiedMemoryEvent('alex', 'task_started', 1, 'alex task_started');
  });

  await test('alex wrote task_completed event', async () => {
    await assertUnifiedMemoryEvent('alex', 'task_completed', 1, 'alex task_completed');
  });

  await test('email-writer wrote task_started event', async () => {
    await assertUnifiedMemoryEvent('email-writer', 'task_started', 1, 'email-writer task_started');
  });

  await test('email-writer wrote task_completed event', async () => {
    await assertUnifiedMemoryEvent('email-writer', 'task_completed', 1, 'email-writer task_completed');
  });

  // ── Step 5: Verify agent_memory workflow steps ────────────────────────────
  console.log('\n[Step 5] Verify email-writer agent_memory workflow steps');
  await test('email-writer wrote >= 3 workflow_step entries', async () => {
    await assertAgentMemorySteps('email-writer', 3, 'email-writer workflow');
  });

  // ── Step 6: Verify searchable via readUnifiedMemory ──────────────────────
  console.log('\n[Step 6] Verify memory is searchable');
  await test('readUnifiedMemory finds email-writer events', async () => {
    const rows = await readUnifiedMemory('welcome email TrustCore', {
      agent_slug: 'email-writer',
      limit: 5,
    });
    assert(rows.length > 0, 'expected at least 1 result from email-writer');
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n====================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);

  await pool.end();

  if (failed > 0) {
    console.error('\n✗ Integration test FAILED');
    process.exit(1);
  }

  console.log('\n✓ Integration test PASSED — full chain verified');
  process.exit(0);
}

main().catch((err) => {
  console.error('Integration test crashed:', err);
  process.exit(1);
});
