import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  readUnifiedMemory,
  writeUnifiedMemory,
  readOwnMemory,
  writeOwnMemory,
  logToolCall,
  createTask,
  updateTask,
  searchKnowledgeBase,
} from './tools.js';

// ---------------------------------------------------------------------------
// Tool schemas (zod for validation)
// ---------------------------------------------------------------------------

const UNIFIED_EVENT_TYPES = ['task_started', 'task_completed', 'task_failed', 'agent_called', 'user_interaction', 'observation', 'consolidation_summary'] as const;
const AGENT_MEMORY_TYPES = ['workflow_step', 'tool_use', 'feedback', 'observation', 'learned_preference'] as const;

const ReadUnifiedMemorySchema = z.object({
  query: z.string().describe('Semantic search query'),
  agent_slug: z.string().optional().describe('Filter by agent slug'),
  event_type: z.enum(UNIFIED_EVENT_TYPES).optional(),
  min_importance: z.number().int().min(1).max(5).optional(),
  session_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

const WriteUnifiedMemorySchema = z.object({
  agent_slug: z.string().describe('Agent writing this memory'),
  event_type: z.enum(UNIFIED_EVENT_TYPES),
  summary: z.string().describe('One-line summary'),
  content: z.unknown().describe('Detail (any JSON)'),
  importance: z.number().int().min(1).max(5).optional().default(3),
  session_id: z.string().uuid().optional(),
});

const ReadOwnMemorySchema = z.object({
  agent_slug: z.string(),
  query: z.string().describe('Semantic search query'),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

const WriteOwnMemorySchema = z.object({
  agent_slug: z.string(),
  memory_type: z.enum(AGENT_MEMORY_TYPES),
  summary: z.string(),
  content: z.string(),
  importance: z.number().int().min(1).max(5).optional().default(3),
});

const LogToolCallSchema = z.object({
  agent_slug: z.string(),
  tool_name: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  status: z.enum(['success', 'error', 'timeout']),
  duration_ms: z.number().int().optional(),
  task_id: z.string().uuid().optional(),
});

const CreateTaskSchema = z.object({
  created_by: z.string().describe('Agent slug creating the task'),
  title: z.string(),
  description: z.string().optional(),
  assigned_to: z.string().optional().describe('Agent slug to assign to'),
  parent_task_id: z.string().uuid().optional(),
});

const UpdateTaskSchema = z.object({
  task_id: z.string().uuid(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']),
  result: z.string().optional(),
});

const SearchKnowledgeBaseSchema = z.object({
  query: z.string(),
  agent_slug: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional().default(10),
});

// ---------------------------------------------------------------------------
// Tool definitions for ListTools
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    name: 'read_unified_memory',
    description: 'Semantic search across all agents\' shared memory. Returns events ranked by importance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        agent_slug: { type: 'string' },
        event_type: { type: 'string' },
        min_importance: { type: 'number' },
        session_id: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'write_unified_memory',
    description: 'Log an event to the shared consciousness (unified memory).',
    inputSchema: {
      type: 'object',
      properties: {
        agent_slug: { type: 'string' },
        event_type: { type: 'string' },
        summary: { type: 'string' },
        content: { type: 'string' },
        importance: { type: 'number' },
        session_id: { type: 'string' },
      },
      required: ['agent_slug', 'event_type', 'summary', 'content'],
    },
  },
  {
    name: 'read_own_memory',
    description: 'Read an agent\'s private journal entries.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_slug: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['agent_slug', 'query'],
    },
  },
  {
    name: 'write_own_memory',
    description: 'Write to an agent\'s private journal.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_slug: { type: 'string' },
        memory_type: { type: 'string' },
        summary: { type: 'string' },
        content: { type: 'string' },
        importance: { type: 'number' },
      },
      required: ['agent_slug', 'memory_type', 'summary', 'content'],
    },
  },
  {
    name: 'log_tool_call',
    description: 'Log a raw tool call for operational instrumentation.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_slug: { type: 'string' },
        tool_name: { type: 'string' },
        input: { type: 'object' },
        output: { type: 'object' },
        status: { type: 'string', enum: ['success', 'error', 'timeout'] },
        duration_ms: { type: 'number' },
        task_id: { type: 'string' },
      },
      required: ['agent_slug', 'tool_name', 'input', 'output', 'status'],
    },
  },
  {
    name: 'create_task',
    description: 'Spawn a new task (node in the task tree).',
    inputSchema: {
      type: 'object',
      properties: {
        created_by: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        assigned_to: { type: 'string' },
        parent_task_id: { type: 'string' },
      },
      required: ['created_by', 'title'],
    },
  },
  {
    name: 'update_task',
    description: 'Update the status of a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] },
        result: { type: 'string' },
      },
      required: ['task_id', 'status'],
    },
  },
  {
    name: 'search_knowledge_base',
    description: 'Search global or agent-specific RAG knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        agent_slug: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
];

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'trustcore-memory', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
      let result: unknown;

      switch (name) {
        case 'read_unified_memory': {
          const p = ReadUnifiedMemorySchema.parse(args);
          result = await readUnifiedMemory(p.query, {
            agent_slug: p.agent_slug,
            event_type: p.event_type,
            min_importance: p.min_importance,
            session_id: p.session_id,
            limit: p.limit,
          });
          break;
        }
        case 'write_unified_memory': {
          const p = WriteUnifiedMemorySchema.parse(args);
          result = await writeUnifiedMemory(
            p.agent_slug,
            p.event_type,
            p.summary,
            p.content,
            p.importance,
            p.session_id
          );
          break;
        }
        case 'read_own_memory': {
          const p = ReadOwnMemorySchema.parse(args);
          result = await readOwnMemory(p.agent_slug, p.query, p.limit);
          break;
        }
        case 'write_own_memory': {
          const p = WriteOwnMemorySchema.parse(args);
          result = await writeOwnMemory(
            p.agent_slug,
            p.memory_type,
            p.summary,
            p.content,
            p.importance
          );
          break;
        }
        case 'log_tool_call': {
          const p = LogToolCallSchema.parse(args);
          result = await logToolCall(
            p.agent_slug,
            p.tool_name,
            p.input,
            p.output,
            p.status,
            p.duration_ms,
            p.task_id
          );
          break;
        }
        case 'create_task': {
          const p = CreateTaskSchema.parse(args);
          result = await createTask(p.created_by, p.title, p.description, p.assigned_to, p.parent_task_id);
          break;
        }
        case 'update_task': {
          const p = UpdateTaskSchema.parse(args);
          await updateTask(p.task_id, p.status, p.result);
          result = { ok: true };
          break;
        }
        case 'search_knowledge_base': {
          const p = SearchKnowledgeBaseSchema.parse(args);
          result = await searchKnowledgeBase(p.query, p.agent_slug, p.limit);
          break;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('TrustCore MCP server running on stdio');
}
