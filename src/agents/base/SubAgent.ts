/**
 * SubAgent — base class for all TrustCore sub-agents.
 *
 * Each sub-agent:
 *  - Has a slug (matches `agents.slug` in the DB)
 *  - Polls for tasks assigned to it
 *  - Implements `handleTask()` to do the actual work
 *  - Logs memory and tool calls via the MCP tools layer
 */

import { pool, query } from '../../db/client.js';
import {
  writeUnifiedMemory,
  writeOwnMemory,
  logToolCall,
  updateTask,
  resolveAgentId,
  type UnifiedEventType,
  type AgentMemoryType,
} from '../../mcp/tools.js';

export interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
}

export abstract class SubAgent {
  readonly slug: string;
  readonly displayName: string;
  private pollIntervalMs: number;
  private intervalHandle?: ReturnType<typeof setInterval>;

  constructor(slug: string, displayName: string, pollIntervalMs = 30_000) {
    this.slug = slug;
    this.displayName = displayName;
    this.pollIntervalMs = pollIntervalMs;
  }

  // ---------------------------------------------------------------------------
  // Abstract: subclasses implement this
  // ---------------------------------------------------------------------------

  abstract handleTask(task: TaskRecord): Promise<unknown>;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    console.log(`[${this.displayName}] Starting up...`);

    await this.log('observation', `${this.displayName} agent started`, {
      message: `${this.slug} initialized at ${new Date().toISOString()}`,
    });

    await this.pollTasks();

    this.intervalHandle = setInterval(async () => {
      try {
        await this.pollTasks();
      } catch (err) {
        console.error(`[${this.displayName}] Poll error:`, err);
      }
    }, this.pollIntervalMs);

    process.on('SIGINT', () => this.shutdown());
  }

  private async shutdown(): Promise<void> {
    console.log(`\n[${this.displayName}] Shutting down...`);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    await this.log('observation', `${this.displayName} agent stopped`, {
      message: `${this.slug} shut down at ${new Date().toISOString()}`,
    });
    await pool.end();
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Task polling
  // ---------------------------------------------------------------------------

  private async pollTasks(): Promise<void> {
    const result = await query<TaskRecord>(
      `SELECT t.id, t.title, t.description
       FROM tasks t
       JOIN agents a ON a.id = t.assigned_to_agent_id
       WHERE a.slug = $1 AND t.status = 'pending'
       ORDER BY t.created_at ASC
       LIMIT 5`,
      [this.slug]
    );

    if (result.rows.length === 0) return;
    console.log(`[${this.displayName}] ${result.rows.length} pending task(s)`);

    for (const task of result.rows) {
      await this.processTask(task);
    }
  }

  private async processTask(task: TaskRecord): Promise<void> {
    console.log(`[${this.displayName}] Processing: ${task.title}`);

    await updateTask(task.id, 'in_progress');
    await this.log('task_started', `${this.displayName} started: ${task.title}`, {
      task_id: task.id,
    });

    try {
      const result = await this.handleTask(task);
      await updateTask(task.id, 'completed', result);
      await this.log('task_completed', `${this.displayName} completed: ${task.title}`, {
        task_id: task.id,
        result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.displayName}] Task failed: ${message}`);
      await updateTask(task.id, 'failed', { error: message });
      await this.log('task_failed', `${this.displayName} failed: ${task.title}`, {
        task_id: task.id,
        error: message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helper shortcuts
  // ---------------------------------------------------------------------------

  protected async log(
    eventType: UnifiedEventType,
    summary: string,
    content: unknown,
    importance = 3
  ): Promise<void> {
    await writeUnifiedMemory(this.slug, eventType, summary, content, importance);
  }

  protected async remember(
    memoryType: AgentMemoryType,
    summary: string,
    content: unknown,
    importance = 3
  ): Promise<void> {
    await writeOwnMemory(this.slug, memoryType, summary, content, importance);
  }

  protected async instrument(
    toolName: string,
    input: unknown,
    fn: () => Promise<unknown>,
    taskId?: string
  ): Promise<unknown> {
    const start = Date.now();
    try {
      const output = await fn();
      await logToolCall(this.slug, toolName, input, output, 'success', Date.now() - start, taskId);
      return output;
    } catch (err) {
      const output = { error: err instanceof Error ? err.message : String(err) };
      await logToolCall(this.slug, toolName, input, output, 'error', Date.now() - start, taskId);
      throw err;
    }
  }

  protected async getAgentId(): Promise<string> {
    return resolveAgentId(this.slug);
  }
}
