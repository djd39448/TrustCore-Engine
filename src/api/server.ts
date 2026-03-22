/**
 * Mission Control API server.
 *
 * Provides HTTP endpoints and a WebSocket channel for the dashboard UI
 * to read agent state, tasks, memories, and tool calls in real time.
 *
 * Run: node --loader ts-node/esm src/index.ts api
 * Default port: 3002 (set API_PORT env var to override)
 */

import express, { type Request, type Response } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { pool, query } from '../db/client.js';
import { getGPUStatus, startResourceManager, stopResourceManager } from '../resource-manager/index.js';
import { getQueueStatus } from '../resource-manager/queue.js';

const PORT = parseInt(process.env['API_PORT'] ?? '3002', 10);

// ---------------------------------------------------------------------------
// WebSocket broadcast helpers
// ---------------------------------------------------------------------------

let wss: WebSocketServer;

function broadcast(event: string, data: unknown): void {
  if (!wss) return;
  const payload = JSON.stringify({ event, data, ts: new Date().toISOString() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Poll DB for new events and broadcast to connected clients
// ---------------------------------------------------------------------------

let lastBroadcastAt = new Date();

async function pollAndBroadcast(): Promise<void> {
  try {
    // Broadcast new tasks
    const tasks = await query<{ id: string; title: string; status: string; created_at: Date }>(
      `SELECT id, title, status, created_at FROM tasks
       WHERE updated_at > $1
       ORDER BY updated_at ASC`,
      [lastBroadcastAt]
    );

    for (const task of tasks.rows) {
      broadcast('task_update', task);
    }

    // Broadcast new unified_memory entries
    const memories = await query<{
      id: string;
      event_type: string;
      summary: string;
      importance: number;
      created_at: Date;
    }>(
      `SELECT um.id, um.event_type, um.summary, um.importance, um.created_at,
              a.slug as agent_slug
       FROM unified_memory um
       JOIN agents a ON a.id = um.author_agent_id
       WHERE um.created_at > $1
       ORDER BY um.created_at ASC`,
      [lastBroadcastAt]
    );

    for (const mem of memories.rows) {
      broadcast('memory_event', mem);
    }

    if (tasks.rows.length > 0 || memories.rows.length > 0) {
      lastBroadcastAt = new Date();
    }
  } catch (err) {
    console.error('[API] Poll error:', err);
  }
}

// ---------------------------------------------------------------------------
// Express routes
// ---------------------------------------------------------------------------

export async function startApiServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  // CORS for local dashboard dev
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // --- Agents ---
  app.get('/api/agents', async (_req: Request, res: Response) => {
    const result = await query(
      `SELECT id, slug, display_name, type, description, is_active, created_at
       FROM agents ORDER BY created_at ASC`
    );
    res.json(result.rows);
  });

  // --- Tasks ---
  app.get('/api/tasks', async (req: Request, res: Response) => {
    const { status, agent, limit = '50', offset = '0' } = req.query as Record<string, string>;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      params.push(status);
      conditions.push(`t.status = $${params.length}`);
    }
    if (agent) {
      params.push(agent);
      conditions.push(`a.slug = $${params.length}`);
    }

    params.push(parseInt(limit, 10), parseInt(offset, 10));
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT t.id, t.title, t.description, t.status, t.result,
              t.created_at, t.started_at, t.completed_at,
              a.slug as assigned_to, cb.slug as created_by,
              pt.title as parent_task_title
       FROM tasks t
       LEFT JOIN agents a ON a.id = t.assigned_to_agent_id
       LEFT JOIN agents cb ON cb.id = t.created_by_agent_id
       LEFT JOIN tasks pt ON pt.id = t.parent_task_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  });

  app.post('/api/tasks', async (req: Request, res: Response) => {
    const { title, description, assigned_to, assignee } = req.body as {
      title?: string;
      description?: string;
      assigned_to?: string;
      assignee?: string;
    };

    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    // Tasks created via API are attributed to "system" agent
    const systemAgent = await query<{ id: string }>(
      `SELECT id FROM agents WHERE slug = 'system' LIMIT 1`
    );
    const createdById = systemAgent.rows[0]?.id;
    if (!createdById) {
      res.status(500).json({ error: 'System agent not found' });
      return;
    }

    const slug = assignee ?? assigned_to;
    let assignedToId: string | null = null;
    if (slug) {
      const ag = await query<{ id: string }>(
        `SELECT id FROM agents WHERE slug = $1 AND is_active = true`,
        [slug]
      );
      assignedToId = ag.rows[0]?.id ?? null;
    }

    const result = await query<{ id: string }>(
      `INSERT INTO tasks (created_by_agent_id, assigned_to_agent_id, title, description, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [createdById, assignedToId, title, description ?? null]
    );

    const taskId = result.rows[0]!.id;
    broadcast('task_created', { id: taskId, title, assigned_to, status: 'pending' });
    res.status(201).json({ id: taskId });
  });

  // --- Memories ---
  app.get('/api/memories', async (req: Request, res: Response) => {
    const { agent, event_type, limit = '50', offset = '0' } = req.query as Record<string, string>;
    const conditions: string[] = ['um.is_archived = false'];
    const params: unknown[] = [];

    if (agent) {
      params.push(agent);
      conditions.push(`a.slug = $${params.length}`);
    }
    if (event_type) {
      params.push(event_type);
      conditions.push(`um.event_type = $${params.length}`);
    }

    params.push(parseInt(limit, 10), parseInt(offset, 10));
    const where = `WHERE ${conditions.join(' AND ')}`;

    const result = await query(
      `SELECT um.id, um.event_type, um.summary, um.content, um.importance,
              um.created_at, a.slug as agent_slug, a.display_name as agent_name
       FROM unified_memory um
       JOIN agents a ON a.id = um.author_agent_id
       ${where}
       ORDER BY um.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  });

  // --- Tool calls ---
  app.get('/api/tool-calls', async (req: Request, res: Response) => {
    const { agent, limit = '50', offset = '0' } = req.query as Record<string, string>;
    const params: unknown[] = [];
    let agentFilter = '';

    if (agent) {
      params.push(agent);
      agentFilter = `WHERE a.slug = $${params.length}`;
    }

    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const result = await query(
      `SELECT tc.id, tc.tool_name, tc.status, tc.duration_ms, tc.created_at,
              a.slug as agent_slug
       FROM agent_tool_calls tc
       JOIN agents a ON a.id = tc.agent_id
       ${agentFilter}
       ORDER BY tc.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  });

  // --- Knowledge base ---
  app.get('/api/knowledge', async (req: Request, res: Response) => {
    const { source, limit = '20' } = req.query as Record<string, string>;
    const params: unknown[] = [parseInt(limit, 10)];
    let sourceFilter = '';

    if (source) {
      params.push(source);
      sourceFilter = `AND kb.source = $${params.length}`;
    }

    const result = await query(
      `SELECT id, title, source, chunk_index, left(content, 200) as preview, created_at
       FROM knowledge_base kb
       WHERE true ${sourceFilter}
       ORDER BY source, chunk_index
       LIMIT $1`,
      params
    );
    res.json(result.rows);
  });

  // --- Agent memories (individual agent_memory journal) ---
  app.get('/api/agents/:slug/memories', async (req: Request, res: Response) => {
    const { slug } = req.params;
    const { limit = '20' } = req.query as Record<string, string>;
    const result = await query(
      `SELECT am.id, am.memory_type as event_type, am.summary, am.content, am.importance, am.created_at
       FROM agent_memory am
       JOIN agents a ON a.id = am.agent_id
       WHERE a.slug = $1 AND am.is_archived = false
       ORDER BY am.created_at DESC
       LIMIT $2`,
      [slug, parseInt(limit, 10)]
    );
    res.json(result.rows);
  });

  // --- GPU status ---
  app.get('/api/gpu', async (_req: Request, res: Response) => {
    const mem = getGPUStatus();
    if (mem.length > 0) { res.json(mem); return; }
    // Fall back to latest DB row per GPU (when resource-manager runs separately)
    const result = await query(
      `SELECT DISTINCT ON (gpu_index)
         gpu_index as "index", gpu_name as name,
         memory_used_mb as "memoryUsedMb", memory_free_mb as "memoryFreeMb",
         memory_total_mb as "memoryTotalMb",
         utilization_percent as "utilizationPct", temperature_c as "temperatureC"
       FROM gpu_metrics
       ORDER BY gpu_index, recorded_at DESC`
    );
    res.json(result.rows);
  });

  // --- GPU metrics history ---
  app.get('/api/gpu/history', async (req: Request, res: Response) => {
    const minutes = Math.min(parseInt((req.query as Record<string, string>)['minutes'] ?? '60', 10), 1440);
    const result = await query(
      `SELECT gpu_index, gpu_name, memory_used_mb, memory_free_mb, memory_total_mb,
              utilization_percent, temperature_c, recorded_at
       FROM gpu_metrics
       WHERE recorded_at > now() - ($1 || ' minutes')::interval
       ORDER BY recorded_at ASC`,
      [minutes]
    );
    res.json(result.rows);
  });

  // --- LLM queue status ---
  app.get('/api/queue', (_req: Request, res: Response) => {
    res.json(getQueueStatus());
  });

  // --- Heartbeat (last Alex heartbeat from unified_memory) ---
  app.get('/api/heartbeat', async (_req: Request, res: Response) => {
    const result = await query(
      `SELECT um.created_at, a.slug as agent_slug
       FROM unified_memory um
       JOIN agents a ON a.id = um.author_agent_id
       WHERE um.event_type = 'heartbeat'
       ORDER BY um.created_at DESC
       LIMIT 1`
    );
    const row = result.rows[0] as { created_at: string; agent_slug: string } | undefined;
    res.json(row ? { last_heartbeat: row.created_at, agent: row.agent_slug } : { last_heartbeat: null, agent: null });
  });

  // --- System stats ---
  app.get('/api/stats', async (_req: Request, res: Response) => {
    const [agentStats, taskBreakdown, memoryStats, recentTasks] = await Promise.all([
      // Per-agent: tasks completed/failed in last 24h + all time
      query<{
        slug: string; display_name: string; is_active: boolean;
        total: string; completed: string; failed: string;
        last_24h_completed: string; last_24h_failed: string;
      }>(`
        SELECT a.slug, a.display_name, a.is_active,
               COUNT(t.id) AS total,
               COUNT(t.id) FILTER (WHERE t.status = 'completed') AS completed,
               COUNT(t.id) FILTER (WHERE t.status = 'failed') AS failed,
               COUNT(t.id) FILTER (WHERE t.status = 'completed' AND t.completed_at > NOW() - INTERVAL '24 hours') AS last_24h_completed,
               COUNT(t.id) FILTER (WHERE t.status = 'failed' AND t.completed_at > NOW() - INTERVAL '24 hours') AS last_24h_failed
        FROM agents a
        LEFT JOIN tasks t ON t.assigned_to_agent_id = a.id
        WHERE a.slug != 'system'
        GROUP BY a.id, a.slug, a.display_name, a.is_active
        ORDER BY total DESC`),

      // Overall task counts by status
      query<{ status: string; count: string }>(
        `SELECT status, COUNT(*) as count FROM tasks GROUP BY status ORDER BY status`),

      // Memory event counts by type (last 24h vs all time)
      query<{ event_type: string; total: string; last_24h: string }>(`
        SELECT event_type,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_24h
        FROM unified_memory
        WHERE is_archived = false
        GROUP BY event_type
        ORDER BY total DESC`),

      // Last heartbeat + avg task duration
      query<{ last_heartbeat: Date; avg_duration_s: string | null }>(`
        SELECT
          (SELECT MAX(created_at) FROM unified_memory WHERE event_type = 'heartbeat') AS last_heartbeat,
          (SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))
           FROM tasks WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL) AS avg_duration_s`),
    ]);

    res.json({
      agents: agentStats.rows,
      tasks: taskBreakdown.rows,
      memory: memoryStats.rows,
      system: recentTasks.rows[0] ?? {},
    });
  });

  // --- Health ---
  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

  // ---------------------------------------------------------------------------
  // HTTP + WebSocket server
  // ---------------------------------------------------------------------------

  const httpServer = createServer(app);
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    console.log('[API] WebSocket client connected');
    ws.send(JSON.stringify({ event: 'connected', ts: new Date().toISOString() }));
    ws.on('close', () => console.log('[API] WebSocket client disconnected'));
  });

  // Poll DB every 2s and push updates to connected WS clients
  const pollInterval = setInterval(pollAndBroadcast, 2000);

  // Start GPU resource manager
  startResourceManager();

  httpServer.listen(PORT, () => {
    console.log(`[API] Mission Control API listening on http://localhost:${PORT}`);
    console.log(`[API] WebSocket available at ws://localhost:${PORT}`);
  });

  process.on('SIGINT', async () => {
    console.log('\n[API] Shutting down...');
    clearInterval(pollInterval);
    stopResourceManager();
    wss.close();
    httpServer.close();
    await pool.end();
    process.exit(0);
  });
}
