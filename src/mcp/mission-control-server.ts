/**
 * mission-control-server.ts — Read-only MCP server for the Mission Control UI.
 *
 * This is a *separate* MCP server from the agent tools server (server.ts).
 * Its purpose is to bridge the Mission Control Next.js dashboard to the
 * PostgreSQL database without going through the REST API.
 *
 * Available tools (all read-only):
 *   - get_recent_activity   — latest unified_memory events (the live feed)
 *   - get_tasks             — task board data (filter by status / agent)
 *   - get_agents            — all agents + task queue depth
 *   - get_consolidations    — recent memory consolidation records
 *
 * Why a separate MCP server?
 *   - The agent MCP server (server.ts) is write-heavy and runs over stdio
 *     as the agent's tool backend. Mixing UI-read and agent-write traffic
 *     into a single server creates coupling and risk of accidental writes.
 *   - Having a dedicated read-only server lets the dashboard talk directly
 *     to the DB model without depending on the agent being alive.
 *
 * Run: node --loader ts-node/esm src/index.ts mc-mcp
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { pool, query } from '../db/client.js';
import { getAgentStatuses } from '../agents/registry.js';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const GetRecentActivitySchema = z.object({
  limit: z.number().int().min(1).max(200).optional().default(50),
  agent_slug: z.string().optional(),
  event_type: z.string().optional(),
});

const GetTasksSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']).optional(),
  assigned_to: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
});

const GetConsolidationsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
});

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function getRecentActivity(input: z.infer<typeof GetRecentActivitySchema>) {
  const conditions: string[] = ['um.is_archived = false'];
  const params: unknown[] = [];

  if (input.agent_slug) {
    params.push(input.agent_slug);
    conditions.push(`a.slug = $${params.length}`);
  }
  if (input.event_type) {
    params.push(input.event_type);
    conditions.push(`um.event_type = $${params.length}`);
  }

  params.push(input.limit);
  const where = `WHERE ${conditions.join(' AND ')}`;

  const result = await query(
    `SELECT um.id, um.event_type, um.summary, um.content, um.importance,
            um.created_at, a.slug as agent_slug, a.display_name as agent_name
     FROM unified_memory um
     JOIN agents a ON a.id = um.author_agent_id
     ${where}
     ORDER BY um.created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows;
}

async function getTasks(input: z.infer<typeof GetTasksSchema>) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (input.status) {
    params.push(input.status);
    conditions.push(`t.status = $${params.length}`);
  }
  if (input.assigned_to) {
    params.push(input.assigned_to);
    conditions.push(`a.slug = $${params.length}`);
  }

  params.push(input.limit);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query(
    `SELECT t.id, t.title, t.description, t.status, t.result,
            t.created_at, t.started_at, t.completed_at,
            a.slug as assigned_to, cb.slug as created_by
     FROM tasks t
     LEFT JOIN agents a ON a.id = t.assigned_to_agent_id
     LEFT JOIN agents cb ON cb.id = t.created_by_agent_id
     ${where}
     ORDER BY t.created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows;
}

async function getConsolidations(input: z.infer<typeof GetConsolidationsSchema>) {
  const result = await query(
    `SELECT mc.id, mc.memory_count, mc.time_range_start, mc.time_range_end,
            mc.created_at, um.summary as consolidation_summary
     FROM memory_consolidations mc
     JOIN unified_memory um ON um.id = mc.summary_memory_id
     ORDER BY mc.created_at DESC
     LIMIT $1`,
    [input.limit]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startMissionControlMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'trustcore-mission-control', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_recent_activity',
        description: 'Get recent unified memory events (the live activity feed)',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max events to return (default 50)' },
            agent_slug: { type: 'string', description: 'Filter to a specific agent' },
            event_type: { type: 'string', description: 'Filter by event type' },
          },
        },
      },
      {
        name: 'get_tasks',
        description: 'Get tasks for the task board (filter by status and/or agent)',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] },
            assigned_to: { type: 'string', description: 'Agent slug' },
            limit: { type: 'number', description: 'Max tasks (default 50)' },
          },
        },
      },
      {
        name: 'get_agents',
        description: 'List all agents with task queue depth and status',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_consolidations',
        description: 'Get recent memory consolidation records',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max records (default 20)' },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
      let data: unknown;

      if (name === 'get_recent_activity') {
        data = await getRecentActivity(GetRecentActivitySchema.parse(args ?? {}));
      } else if (name === 'get_tasks') {
        data = await getTasks(GetTasksSchema.parse(args ?? {}));
      } else if (name === 'get_agents') {
        data = await getAgentStatuses();
      } else if (name === 'get_consolidations') {
        data = await getConsolidations(GetConsolidationsSchema.parse(args ?? {}));
      } else {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
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

  process.on('SIGINT', async () => {
    await pool.end();
    process.exit(0);
  });

  console.error('[MC-MCP] Mission Control MCP server running on stdio');
}
