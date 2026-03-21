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
  | 'consolidation_summary';

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

export async function resolveAgentId(agentSlug: string): Promise<string> {
  const result = await query<{ id: string }>(
    'SELECT id FROM agents WHERE slug = $1 AND is_active = true',
    [agentSlug]
  );
  if (result.rows.length === 0) {
    throw new Error(`Agent not found: ${agentSlug}`);
  }
  return result.rows[0]!.id;
}

// ---------------------------------------------------------------------------
// read_unified_memory
// ---------------------------------------------------------------------------

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
      WHERE ${where} AND um.embedding IS NOT NULL
      ORDER BY um.embedding <=> $${params.length}::vector
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

export async function writeUnifiedMemory(
  agentSlug: string,
  eventType: UnifiedEventType,
  summary: string,
  content: unknown,
  importance: number = 3,
  sessionId?: string
): Promise<{ id: string }> {
  const agentId = await resolveAgentId(agentSlug);

  // Generate embedding from summary + content text
  const textForEmbed = `${summary}\n${typeof content === 'string' ? content : JSON.stringify(content)}`;
  const embedding = await embed(textForEmbed);

  const result = await query<{ id: string }>(
    `INSERT INTO unified_memory
       (author_agent_id, session_id, event_type, summary, content, importance, embedding, embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)
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

  return { id: result.rows[0]!.id };
}

// ---------------------------------------------------------------------------
// read_own_memory
// ---------------------------------------------------------------------------

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
    sql = `
      SELECT id, agent_id, memory_type, summary, content, importance, created_at
      FROM agent_memory
      WHERE agent_id = $1 AND is_archived = false AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
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

export async function writeOwnMemory(
  agentSlug: string,
  memoryType: AgentMemoryType,
  summary: string,
  content: unknown,
  importance: number = 3
): Promise<{ id: string }> {
  const agentId = await resolveAgentId(agentSlug);

  const textForEmbed = `${summary}\n${typeof content === 'string' ? content : JSON.stringify(content)}`;
  const embedding = await embed(textForEmbed);

  const result = await query<{ id: string }>(
    `INSERT INTO agent_memory
       (agent_id, memory_type, summary, content, importance, embedding, embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
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

  return { id: result.rows[0]!.id };
}

// ---------------------------------------------------------------------------
// log_tool_call
// ---------------------------------------------------------------------------

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

  return { id: result.rows[0]!.id };
}

// ---------------------------------------------------------------------------
// create_task  (requires created_by_agent_id)
// ---------------------------------------------------------------------------

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

  return { id: result.rows[0]!.id };
}

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------

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
      WHERE ${agentFilter} AND kb.embedding IS NOT NULL
      ORDER BY kb.embedding <=> $${params.length}::vector
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
