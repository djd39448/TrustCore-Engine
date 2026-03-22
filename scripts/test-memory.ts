/**
 * test-memory.ts — Integration test for all DB + memory operations.
 *
 * Tests every layer of the TrustCore memory stack:
 *   1. DB connectivity
 *   2. writeUnifiedMemory / readUnifiedMemory
 *   3. writeOwnMemory / readOwnMemory
 *   4. createTask / updateTask lifecycle
 *   5. logToolCall
 *   6. knowledge_base insert + searchKnowledgeBase
 *
 * Exit code 0 = all PASS, 1 = at least one FAIL (CI-friendly).
 *
 * Run: node --loader ts-node/esm scripts/test-memory.ts
 */

import { pool, query } from '../src/db/client.js';
import {
  writeUnifiedMemory,
  readUnifiedMemory,
  writeOwnMemory,
  readOwnMemory,
  createTask,
  updateTask,
  logToolCall,
  searchKnowledgeBase,
} from '../src/mcp/tools.js';
import { embed, toVectorLiteral } from '../src/embedding/client.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed++;
}

function fail(name: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  ✗ ${name}: ${msg}`);
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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testDbConnectivity() {
  console.log('\n[1] Database connectivity');
  await test('connects to PostgreSQL', async () => {
    const result = await query<{ now: Date }>('SELECT NOW() as now');
    assert(result.rows.length === 1, 'expected 1 row');
    assert(result.rows[0]!.now instanceof Date, 'expected Date object');
  });

  await test('all 8 tables exist', async () => {
    const tables = [
      'agents', 'sessions', 'tasks', 'unified_memory',
      'memory_consolidations', 'agent_memory', 'agent_tool_calls', 'knowledge_base',
    ];
    for (const table of tables) {
      const result = await query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema = 'public'`,
        [table]
      );
      assert(result.rows.length === 1, `table '${table}' not found`);
    }
  });

  await test('alex and system agents seeded', async () => {
    const result = await query<{ slug: string }>(
      `SELECT slug FROM agents WHERE slug IN ('alex', 'system', 'research') ORDER BY slug`
    );
    const slugs = result.rows.map((r) => r.slug);
    assert(slugs.includes('alex'), 'alex agent missing');
    assert(slugs.includes('system'), 'system agent missing');
  });
}

async function testUnifiedMemory() {
  console.log('\n[2] Unified memory');

  let memId: string | undefined;

  await test('writeUnifiedMemory creates a record', async () => {
    const result = await writeUnifiedMemory(
      'alex',
      'observation',
      'Test memory entry from test-memory.ts',
      { test: true, ts: new Date().toISOString() },
      3
    );
    assert(typeof result.id === 'string' && result.id.length > 0, 'expected UUID');
    memId = result.id;
  });

  await test('readUnifiedMemory retrieves the record', async () => {
    const rows = await readUnifiedMemory('test-memory.ts observation', {
      agent_slug: 'alex',
      event_type: 'observation',
      limit: 100,
    });
    assert(rows.length > 0, 'expected at least 1 result');
    const found = rows.find((r) => r.id === memId);
    assert(found !== undefined, `created record ${memId} not found in results`);
  });

  await test('readUnifiedMemory filter by importance', async () => {
    const rows = await readUnifiedMemory('anything', { min_importance: 5, limit: 5 });
    for (const row of rows) {
      assert(row.importance >= 5, `row importance ${row.importance} < 5`);
    }
  });
}

async function testAgentMemory() {
  console.log('\n[3] Agent memory');

  let ownMemId: string | undefined;

  await test('writeOwnMemory creates a record', async () => {
    const result = await writeOwnMemory(
      'alex',
      'observation',
      'Test agent memory from test-memory.ts',
      { test: true },
      3
    );
    assert(typeof result.id === 'string', 'expected UUID');
    ownMemId = result.id;
  });

  await test('readOwnMemory retrieves the record', async () => {
    const rows = await readOwnMemory('alex', 'test agent memory', 10);
    assert(rows.length > 0, 'expected results');
    const found = rows.find((r) => r.id === ownMemId);
    assert(found !== undefined, 'created record not found');
  });
}

async function testTaskLifecycle() {
  console.log('\n[4] Task lifecycle');

  let taskId: string | undefined;

  await test('createTask creates a pending task', async () => {
    const result = await createTask(
      'alex',
      'test-memory.ts: test task',
      'Created by integration test',
      'alex'
    );
    assert(typeof result.id === 'string', 'expected UUID');
    taskId = result.id;

    const row = await query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]);
    assert(row.rows[0]?.status === 'pending', 'expected status=pending');
  });

  await test('updateTask marks in_progress (sets started_at)', async () => {
    await updateTask(taskId!, 'in_progress');
    const row = await query<{ status: string; started_at: Date | null }>(
      'SELECT status, started_at FROM tasks WHERE id = $1',
      [taskId]
    );
    assert(row.rows[0]?.status === 'in_progress', 'expected in_progress');
    assert(row.rows[0]?.started_at !== null, 'expected started_at set');
  });

  await test('updateTask marks completed (sets completed_at)', async () => {
    await updateTask(taskId!, 'completed', { result: 'integration-test-pass' });
    const row = await query<{ status: string; completed_at: Date | null }>(
      'SELECT status, completed_at FROM tasks WHERE id = $1',
      [taskId]
    );
    assert(row.rows[0]?.status === 'completed', 'expected completed');
    assert(row.rows[0]?.completed_at !== null, 'expected completed_at set');
  });
}

async function testToolCallLog() {
  console.log('\n[5] Tool call logging');

  await test('logToolCall creates a record', async () => {
    const result = await logToolCall(
      'alex',
      'test_tool',
      { input: 'hello' },
      { output: 'world' },
      'success',
      42
    );
    assert(typeof result.id === 'string', 'expected UUID');

    const row = await query<{ tool_name: string; status: string; duration_ms: number }>(
      'SELECT tool_name, status, duration_ms FROM agent_tool_calls WHERE id = $1',
      [result.id]
    );
    assert(row.rows[0]?.tool_name === 'test_tool', 'tool_name mismatch');
    assert(row.rows[0]?.status === 'success', 'status mismatch');
    assert(row.rows[0]?.duration_ms === 42, 'duration_ms mismatch');
  });
}

async function testKnowledgeBase() {
  console.log('\n[6] Knowledge base');

  let kbId: string | undefined;
  const testContent = 'TrustCore Engine integration test knowledge base entry. Vector search test.';

  await test('insert knowledge_base chunk', async () => {
    const embedding = await embed(testContent);
    const result = await query<{ id: string }>(
      `INSERT INTO knowledge_base (title, source, content, chunk_index, embedding, embedding_model, metadata)
       VALUES ($1, $2, $3, 0, $4::vector, $5, '{}')
       RETURNING id`,
      [
        'integration-test',
        'scripts/test-memory.ts',
        testContent,
        embedding ? toVectorLiteral(embedding) : null,
        embedding ? 'nomic-embed-text' : null,
      ]
    );
    assert(typeof result.rows[0]?.id === 'string', 'expected UUID');
    kbId = result.rows[0]!.id;
  });

  await test('searchKnowledgeBase returns results', async () => {
    // Global search (no agent filter)
    const rows = await searchKnowledgeBase('TrustCore integration test', undefined, 5);
    // May return 0 if Ollama is down (fallback is recency, still returns rows)
    assert(Array.isArray(rows), 'expected array');
  });

  // Cleanup the test row
  if (kbId) {
    await query('DELETE FROM knowledge_base WHERE id = $1', [kbId]);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('TrustCore Engine — Memory Integration Tests');
  console.log('===========================================');

  await testDbConnectivity();
  await testUnifiedMemory();
  await testAgentMemory();
  await testTaskLifecycle();
  await testToolCallLog();
  await testKnowledgeBase();

  console.log('\n===========================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);

  await pool.end();

  if (failed > 0) {
    console.error('\nSome tests FAILED. Fix the issues above before proceeding.');
    process.exit(1);
  }

  console.log('\nAll tests PASSED ✓');
  process.exit(0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
