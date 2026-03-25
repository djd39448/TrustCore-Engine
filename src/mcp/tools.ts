/**
 * MCP Tools Layer — the shared interface between agents and the database.
 *
 * Every agent interaction with persistent state goes through this module.
 * Direct SQL queries from agent code are forbidden — everything must flow
 * through these tool functions so that:
 *   - Memory writes always attempt embedding (semantic search works)
 *   - Tool calls are logged to agent_tool_calls for observability
 *   - Agent IDs are resolved by slug so agents never hardcode UUIDs
 *   - The MCP server can expose these same functions over stdio
 *
 * The two memory tables:
 *   unified_memory  — shared consciousness, all agents can read/write
 *   agent_memory    — private journal, only the owning agent writes to it
 *
 * Both tables attempt to store a vector embedding alongside each record.
 * If the embedding model (nomic-embed-text) is unavailable, the record
 * is written with a null embedding and semantic search degrades to
 * recency+importance ranking. This graceful degradation is intentional.
 */

import { query } from '../db/client.js';
import { embed, toVectorLiteral } from '../embedding/client.js';

// ---------------------------------------------------------------------------
// Types matching actual DB schema
// ---------------------------------------------------------------------------

export type UnifiedEventType =
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'agent_called'
  | 'user_interaction'
  | 'observation'
  | 'consolidation_summary'
  | 'heartbeat'
  | 'system_alert';

export type AgentMemoryType =
  | 'workflow_step'
  | 'tool_use'
  | 'feedback'
  | 'observation'
  | 'learned_preference';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
export type ToolCallStatus = 'success' | 'error' | 'timeout';

export interface MemoryFilters {
  agent_slug?: string;
  event_type?: UnifiedEventType;
  min_importance?: number;
  session_id?: string;
  limit?: number;
}

export interface UnifiedMemoryRow {
  id: string;
  author_agent_id: string;
  session_id: string | null;
  event_type: string;
  summary: string;
  content: unknown;
  importance: number;
  created_at: Date;
}

export interface AgentMemoryRow {
  id: string;
  agent_id: string;
  memory_type: string;
  summary: string;
  content: unknown;
  importance: number;
  created_at: Date;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assigned_to_agent_id: string | null;
  parent_task_id: string | null;
  created_at: Date;
}

export interface KnowledgeBaseRow {
  id: string;
  agent_id: string | null;
  title: string;
  content: string;
  source: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Helper: resolve agent_id from slug
// ---------------------------------------------------------------------------

/**
 * Resolve an agent's UUID from its human-readable slug.
 * Throws if the agent doesn't exist or is inactive — callers should not
 * proceed if the agent isn't in the DB (likely a missing seed.sql entry).
 */
export async function resolveAgentId(agentSlug: string): Promise<string> {
  const result = await query<{ id: string }>(
    'SELECT id FROM agents WHERE slug = $1 AND is_active = true',
    [agentSlug]
  );
  const agentRow = result.rows[0];
  if (!agentRow) {
    throw new Error(`Agent not found: ${agentSlug}`);
  }
  return agentRow.id;
}

// ---------------------------------------------------------------------------
// read_unified_memory
// ---------------------------------------------------------------------------

/**
 * Read from unified_memory (the shared consciousness visible to all agents).
 *
 * Search strategy:
 *   - If nomic-embed-text is available: vector cosine similarity search,
 *     with null-embedding rows sorted last (they degrade to recency ranking).
 *   - If embedding is unavailable: recency + importance ranking only.
 *
 * Filters narrow results before ranking. All filters are AND-combined.
 * Limit defaults to 20 if not specified in filters.
 */
export async function readUnifiedMemory(
  searchQuery: string,
  filters: MemoryFilters = {}
): Promise<UnifiedMemoryRow[]> {
  const conditions: string[] = ['um.is_archived = false'];
  const params: unknown[] = [];

  if (filters.agent_slug) {
    const agentId = await resolveAgentId(filters.agent_slug);
    params.push(agentId);
    conditions.push(`um.author_agent_id = $${params.length}`);
  }

  if (filters.event_type) {
    params.push(filters.event_type);
    conditions.push(`um.event_type = $${params.length}`);
  }

  if (filters.min_importance !== undefined) {
    params.push(filters.min_importance);
    conditions.push(`um.importance >= $${params.length}`);
  }

  if (filters.session_id) {
    params.push(filters.session_id);
    conditions.push(`um.session_id = $${params.length}`);
  }

  const limit = filters.limit ?? 20;
  params.push(limit);
  const where = conditions.join(' AND ');

  // Try vector search first; fall back to recency+importance ranking
  const queryEmbedding = await embed(searchQuery);
  let sql: string;

  if (queryEmbedding) {
    params.push(toVectorLiteral(queryEmbedding));
    sql = `
      SELECT um.id, um.author_agent_id, um.session_id, um.event_type,
             um.summary, um.content, um.importance, um.created_at
      FROM unified_memory um
      WHERE ${where}
      ORDER BY (CASE WHEN um.embedding IS NOT NULL THEN um.embedding <=> $${params.length}::vector END) NULLS LAST,
               um.importance DESC, um.created_at DESC
      LIMIT $${params.length - 1}
    `;
  } else {
    sql = `
      SELECT um.id, um.author_agent_id, um.session_id, um.event_type,
             um.summary, um.content, um.importance, um.created_at
      FROM unified_memory um
      WHERE ${where}
      ORDER BY um.importance DESC, um.created_at DESC
      LIMIT $${params.length}
    `;
  }

  const result = await query<UnifiedMemoryRow>(sql, params);
  return result.rows;
}

// ---------------------------------------------------------------------------
// write_unified_memory
// ---------------------------------------------------------------------------

/**
 * Write an event to unified_memory (the shared consciousness).
 * Always proceeds even if embedding fails — the record is written with
 * a null embedding vector, and semantic search degrades gracefully.
 *
 * Importance scale: 1 (heartbeat/noise) → 5 (critical alert).
 * Low-importance records (≤ 2) are eligible for memory consolidation
 * after CONSOLIDATION_AGE_DAYS days.
 */
export async function writeUnifiedMemory(
  agentSlug: string,
  eventType: UnifiedEventType,
  summary: string,
  content: unknown,
  importance: number = 3,
  sessionId?: string
): Promise<{ id: string }> {
  const agentId = await resolveAgentId(agentSlug);

  // Generate embedding — always proceed even if embedding fails
  const textForEmbed = `${summary}\n${typeof content === 'string' ? content : JSON.stringify(content)}`;
  let embedding: number[] | null = null;
  try {
    embedding = await embed(textForEmbed);
  } catch (embedErr) {
    console.error('[tools] writeUnifiedMemory: embedding failed, writing with null embedding:', embedErr);
  }

  const result = await query<{ id: string }>(
    `INSERT INTO unified_memory
       (author_agent_id, session_id, event_type, summary, content, importance, embedding, embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      agentId,
      sessionId ?? null,
      eventType,
      summary,
      JSON.stringify(content),
      importance,
      embedding ? toVectorLiteral(embedding) : null,
      embedding ? (process.env['EMBEDDING_MODEL'] ?? 'nomic-embed-text') : null,
    ]
  );

  const insertedRow = result.rows[0];
  if (!insertedRow) {
    throw new Error('writeUnifiedMemory INSERT returned no row — database error');
  }
  return { id: insertedRow.id };
}

// ---------------------------------------------------------------------------
// read_own_memory
// ---------------------------------------------------------------------------

/**
 * Read from an agent's private journal (agent_memory).
 * Only returns records owned by agentSlug — other agents' private memories
 * are not accessible through this function by design.
 * Same vector/recency fallback strategy as readUnifiedMemory.
 */
export async function readOwnMemory(
  agentSlug: string,
  searchQuery: string,
  limit: number = 20
): Promise<AgentMemoryRow[]> {
  const agentId = await resolveAgentId(agentSlug);
  const queryEmbedding = await embed(searchQuery);

  let sql: string;
  let params: unknown[];

  if (queryEmbedding) {
    // Include null-embedding rows (written when embed was unavailable); sort them last
    sql = `
      SELECT id, agent_id, memory_type, summary, content, importance, created_at
      FROM agent_memory
      WHERE agent_id = $1 AND is_archived = false
      ORDER BY (CASE WHEN embedding IS NOT NULL THEN embedding <=> $2::vector END) NULLS LAST,
               importance DESC, created_at DESC
      LIMIT $3
    `;
    params = [agentId, toVectorLiteral(queryEmbedding), limit];
  } else {
    sql = `
      SELECT id, agent_id, memory_type, summary, content, importance, created_at
      FROM agent_memory
      WHERE agent_id = $1 AND is_archived = false
      ORDER BY importance DESC, created_at DESC
      LIMIT $2
    `;
    params = [agentId, limit];
  }

  const result = await query<AgentMemoryRow>(sql, params);
  return result.rows;
}

// ---------------------------------------------------------------------------
// write_own_memory
// ---------------------------------------------------------------------------

/**
 * Write to an agent's private journal (agent_memory).
 * Use this for workflow steps, tool observations, and learned preferences
 * that are internal to the agent's reasoning process and not intended for
 * the shared consciousness.
 *
 * Memory types:
 *   workflow_step       — step-by-step progress through a task
 *   tool_use            — record of a tool call and its result
 *   feedback            — correction or preference noted from a user interaction
 *   observation         — general observation about a task or environment
 *   learned_preference  — durable preference to apply to future tasks
 */
export async function writeOwnMemory(
  agentSlug: string,
  memoryType: AgentMemoryType,
  summary: string,
  content: unknown,
  importance: number = 3
): Promise<{ id: string }> {
  const agentId = await resolveAgentId(agentSlug);

  // Generate embedding — always proceed even if embedding fails
  const textForEmbed = `${summary}\n${typeof content === 'string' ? content : JSON.stringify(content)}`;
  let embedding: number[] | null = null;
  try {
    embedding = await embed(textForEmbed);
  } catch (embedErr) {
    console.error('[tools] writeOwnMemory: embedding failed, writing with null embedding:', embedErr);
  }

  const result = await query<{ id: string }>(
    `INSERT INTO agent_memory
       (agent_id, memory_type, summary, content, importance, embedding, embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      agentId,
      memoryType,
      summary,
      JSON.stringify(content),
      importance,
      embedding ? toVectorLiteral(embedding) : null,
      embedding ? (process.env['EMBEDDING_MODEL'] ?? 'nomic-embed-text') : null,
    ]
  );

  const insertedRow = result.rows[0];
  if (!insertedRow) {
    throw new Error('writeOwnMemory INSERT returned no row — database error');
  }
  return { id: insertedRow.id };
}

// ---------------------------------------------------------------------------
// log_tool_call
// ---------------------------------------------------------------------------

/**
 * Log a tool invocation to agent_tool_calls.
 * Called automatically by SubAgent.instrument() — agent code doesn't
 * call this directly unless bypassing the instrument() wrapper.
 *
 * Records input, output, status (success/error/timeout), and wall-clock
 * duration. These records are the raw data for the DPO training pipeline
 * and for cost monitoring (tokens_in/tokens_out added in a later migration).
 */
export async function logToolCall(
  agentSlug: string,
  toolName: string,
  input: unknown,
  output: unknown,
  status: ToolCallStatus,
  durationMs?: number,
  taskId?: string
): Promise<{ id: string }> {
  const agentId = await resolveAgentId(agentSlug);

  const result = await query<{ id: string }>(
    `INSERT INTO agent_tool_calls (agent_id, task_id, tool_name, tool_input, tool_output, status, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      agentId,
      taskId ?? null,
      toolName,
      JSON.stringify(input),
      JSON.stringify(output),
      status,
      durationMs ?? null,
    ]
  );

  const insertedRow = result.rows[0];
  if (!insertedRow) {
    throw new Error('logToolCall INSERT returned no row — database error');
  }
  return { id: insertedRow.id };
}

// ---------------------------------------------------------------------------
// create_task  (requires created_by_agent_id)
// ---------------------------------------------------------------------------

/**
 * Create a new task in the tasks table.
 * Tasks start as 'pending' — the assigned agent's poll loop will pick them up.
 * parentTaskId links sub-tasks back to the parent for delegation tracking.
 * assignedToSlug determines which agent's poll loop will claim the task;
 * if omitted, only Alex (or unassigned) queries will find it.
 */
export async function createTask(
  createdBySlug: string,
  title: string,
  description?: string,
  assignedToSlug?: string,
  parentTaskId?: string
): Promise<{ id: string }> {
  const createdById = await resolveAgentId(createdBySlug);

  let assignedToId: string | null = null;
  if (assignedToSlug) {
    assignedToId = await resolveAgentId(assignedToSlug);
  }

  const result = await query<{ id: string }>(
    `INSERT INTO tasks (created_by_agent_id, assigned_to_agent_id, title, description, parent_task_id, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id`,
    [createdById, assignedToId, title, description ?? null, parentTaskId ?? null]
  );

  const insertedRow = result.rows[0];
  if (!insertedRow) {
    throw new Error('createTask INSERT returned no row — database error');
  }
  return { id: insertedRow.id };
}

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------

/**
 * Transition a task to a new status and optionally store its result payload.
 * Automatically sets started_at on first transition to 'in_progress'
 * and completed_at on any terminal status (completed, failed, cancelled).
 * The result field holds whatever the handling agent returned — it is the
 * primary output of the task and what eval scores against.
 */
export async function updateTask(
  taskId: string,
  status: TaskStatus,
  result?: unknown
): Promise<void> {
  await query(
    `UPDATE tasks
     SET status = $2,
         result = $3,
         started_at  = CASE WHEN $2 = 'in_progress' AND started_at IS NULL THEN NOW() ELSE started_at END,
         completed_at = CASE WHEN $2 IN ('completed', 'failed', 'cancelled') THEN NOW() ELSE NULL END,
         updated_at  = NOW()
     WHERE id = $1`,
    [taskId, status, result !== undefined ? JSON.stringify(result) : '{}']
  );
}

// ---------------------------------------------------------------------------
// search_knowledge_base
// ---------------------------------------------------------------------------

/**
 * RAG retrieval — search the knowledge base for relevant chunks.
 *
 * agentSlug controls visibility:
 *   - If provided: returns global chunks (agent_id IS NULL) plus chunks
 *     owned by this agent. Agents can have private KB entries.
 *   - If omitted: returns only global chunks.
 *
 * Ranking: vector cosine similarity if embedding available, else recency.
 * Used by email-writer and research in their Step 1 context-gathering phase.
 */
export async function searchKnowledgeBase(
  searchQuery: string,
  agentSlug?: string,
  limit: number = 10
): Promise<KnowledgeBaseRow[]> {
  let agentFilter: string;
  const baseParams: unknown[] = [limit];

  if (agentSlug) {
    const agentId = await resolveAgentId(agentSlug);
    baseParams.push(agentId);
    agentFilter = `(kb.agent_id IS NULL OR kb.agent_id = $${baseParams.length})`;
  } else {
    agentFilter = 'kb.agent_id IS NULL';
  }

  const queryEmbedding = await embed(searchQuery);

  let sql: string;
  let params: unknown[];

  if (queryEmbedding) {
    params = [...baseParams, toVectorLiteral(queryEmbedding)];
    sql = `
      SELECT id, agent_id, title, content, source, created_at
      FROM knowledge_base kb
      WHERE ${agentFilter}
      ORDER BY (CASE WHEN kb.embedding IS NOT NULL THEN kb.embedding <=> $${params.length}::vector END) NULLS LAST,
               kb.created_at DESC
      LIMIT $1
    `;
  } else {
    params = baseParams;
    sql = `
      SELECT id, agent_id, title, content, source, created_at
      FROM knowledge_base kb
      WHERE ${agentFilter}
      ORDER BY kb.created_at DESC
      LIMIT $1
    `;
  }

  const result = await query<KnowledgeBaseRow>(sql, params);
  return result.rows;
}
