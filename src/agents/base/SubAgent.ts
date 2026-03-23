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

      // Detect stub/offline results — treat as failure rather than silent bad completion
      const stubError = this.detectStubResult(result);
      if (stubError) {
        console.error(`[${this.displayName}] Task produced stub result: ${stubError}`);
        await updateTask(task.id, 'failed', { error: stubError });
        await this.log('task_failed', `${this.displayName} failed (offline): ${task.title}`, {
          task_id: task.id,
          error: stubError,
        });
        return;
      }

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

  /**
   * Returns an error string if the result looks like a stub/offline response,
   * or null if the result appears genuine.
   */
  private detectStubResult(result: unknown): string | null {
    if (result === null || result === undefined) return null;
    if (typeof result !== 'object') return null;
    const r = result as Record<string, unknown>;
    // Explicit failure markers set by agents when LLM is offline
    if (r['model'] === 'stub') return 'LLM offline — email draft unavailable';
    if (r['source'] === 'stub') return 'Agent returned stub result — LLM unavailable';
    if (r['source'] === 'llm_unavailable') return 'LLM did not respond';
    // Only scan non-LLM fields (body/draft may be LLM output — skip to avoid false positives)
    const agentFields = ['error'];
    for (const field of agentFields) {
      const val = r[field];
      if (typeof val === 'string') {
        const lower = val.toLowerCase();
        if (lower.includes('[stub]') || lower.includes('[error]')) {
          return `Result indicates failure: ${val.slice(0, 120)}`;
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Helper shortcuts
  // ---------------------------------------------------------------------------

  /**
   * Write an event to unified_memory (the shared consciousness).
   * Errors are swallowed — a failed memory write must never crash the agent
   * loop or mark a task as failed. Tasks that succeed despite a memory write
   * failure are still real successes.
   */
  protected async log(
    eventType: UnifiedEventType,
    summary: string,
    content: unknown,
    importance = 3
  ): Promise<void> {
    try {
      await writeUnifiedMemory(this.slug, eventType, summary, content, importance);
    } catch (err) {
      // Memory writes must NEVER crash the agent loop — log and continue
      console.error(`[${this.displayName}] unified_memory write failed (${eventType}):`, err);
    }
  }

  /**
   * Write an entry to the agent's private journal (agent_memory).
   * Use for workflow step tracking, observations, and learned preferences
   * that don't need to be visible to other agents.
   * Same error-swallowing contract as log().
   */
  protected async remember(
    memoryType: AgentMemoryType,
    summary: string,
    content: unknown,
    importance = 3
  ): Promise<void> {
    try {
      await writeOwnMemory(this.slug, memoryType, summary, content, importance);
    } catch (err) {
      // Memory writes must NEVER crash the agent loop — log and continue
      console.error(`[${this.displayName}] agent_memory write failed (${memoryType}):`, err);
    }
  }

  /**
   * Wrap any tool call with automatic timing and logging to agent_tool_calls.
   * On success: records input, output, and duration with status 'success'.
   * On error: records the error message with status 'error', then re-throws
   * so the calling task handler can decide how to handle the failure.
   *
   * This is the observability backbone — every external call an agent makes
   * (LLM, KB search, web search, external API) should go through instrument().
   */
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

  /**
   * Resolve this agent's UUID from the DB.
   * Rarely needed directly — most DB writes go through the tool functions
   * which resolve the agent ID internally. Use this when you need the raw UUID.
   */
  protected async getAgentId(): Promise<string> {
    return resolveAgentId(this.slug);
  }
}
