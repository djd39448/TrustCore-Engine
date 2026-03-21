/**
 * registry.ts — Agent registry and orchestration.
 *
 * The registry is the routing layer between Alex and the sub-agent fleet.
 * It provides two things:
 *
 *   1. A runtime map of known sub-agent slugs so Alex can validate targets
 *      before dispatching (avoids silent DB FK errors).
 *
 *   2. `dispatch(parentTaskId, targetSlug, title, description)`:
 *      Creates a child task assigned to the target agent and logs the
 *      dispatch event to unified_memory. Sub-agents poll for their own
 *      pending tasks, so no direct IPC is needed — the DB is the queue.
 *
 * How orchestration works in TrustCore:
 *   ┌──────┐  classifies  ┌──────────┐  dispatch()  ┌────────────┐
 *   │ Alex │ ──────────▶  │ registry │ ────────────▶ │  tasks DB  │
 *   └──────┘              └──────────┘               └────────────┘
 *                                                           │ polls
 *                                                    ┌──────▼──────┐
 *                                                    │  Sub-agent  │
 *                                                    └─────────────┘
 *
 * Adding a new sub-agent:
 *   1. Create src/agents/<slug>/index.ts extending SubAgent
 *   2. Add the slug to REGISTERED_AGENTS below
 *   3. Add INSERT to db/seed.sql
 *   4. Add case to src/index.ts dispatcher
 */

import { createTask, writeUnifiedMemory, resolveAgentId } from '../mcp/tools.js';
import { query } from '../db/client.js';

// ---------------------------------------------------------------------------
// Known sub-agent slugs (used for dispatch validation)
// ---------------------------------------------------------------------------

/**
 * All sub-agents known to this build of TrustCore.
 * Alex can only dispatch to agents in this set.
 */
export const REGISTERED_AGENTS = new Set([
  'research',
  'email-writer',
]);

// Chief agents — not dispatchable as sub-agents
const CHIEF_AGENTS = new Set(['alex', 'system']);

// ---------------------------------------------------------------------------
// Registry query helpers
// ---------------------------------------------------------------------------

export interface AgentStatus {
  slug: string;
  displayName: string;
  type: string;
  isActive: boolean;
  pendingTasks: number;
  completedTasks: number;
}

/**
 * Returns runtime status for all active agents, including task queue depths.
 * Used by Mission Control API and the /api/agents endpoint.
 */
export async function getAgentStatuses(): Promise<AgentStatus[]> {
  const result = await query<{
    slug: string;
    display_name: string;
    type: string;
    is_active: boolean;
    pending_tasks: string;
    completed_tasks: string;
  }>(
    `SELECT
       a.slug,
       a.display_name,
       a.type,
       a.is_active,
       COUNT(CASE WHEN t.status = 'pending' THEN 1 END)   AS pending_tasks,
       COUNT(CASE WHEN t.status = 'completed' THEN 1 END) AS completed_tasks
     FROM agents a
     LEFT JOIN tasks t ON t.assigned_to_agent_id = a.id
     GROUP BY a.id
     ORDER BY a.created_at`
  );

  return result.rows.map((r) => ({
    slug: r.slug,
    displayName: r.display_name,
    type: r.type,
    isActive: r.is_active,
    pendingTasks: parseInt(r.pending_tasks, 10),
    completedTasks: parseInt(r.completed_tasks, 10),
  }));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchResult {
  subTaskId: string;
  targetAgent: string;
}

/**
 * Dispatch a task to a sub-agent by creating a child task in the DB.
 *
 * The sub-agent's poll loop will pick it up on its next cycle (default 30s).
 * No direct communication — the DB task queue IS the message bus.
 *
 * @param dispatchedBy  Slug of the agent doing the dispatching (usually 'alex')
 * @param parentTaskId  ID of the parent task being delegated
 * @param targetSlug    Slug of the sub-agent to receive the task
 * @param title         Task title (usually inherited from parent)
 * @param description   Optional task description
 */
export async function dispatch(
  dispatchedBy: string,
  parentTaskId: string,
  targetSlug: string,
  title: string,
  description?: string
): Promise<DispatchResult> {
  // Validate target is a known registered sub-agent
  if (CHIEF_AGENTS.has(targetSlug)) {
    throw new Error(
      `Cannot dispatch to chief agent '${targetSlug}'. ` +
      `Only sub-agents (${[...REGISTERED_AGENTS].join(', ')}) can receive dispatched tasks.`
    );
  }

  // Validate the target agent exists in the DB
  const agentCheck = await query<{ id: string; is_active: boolean }>(
    'SELECT id, is_active FROM agents WHERE slug = $1',
    [targetSlug]
  );
  if (agentCheck.rows.length === 0) {
    throw new Error(`Agent '${targetSlug}' not found in DB. Did you run seed.sql?`);
  }
  if (!agentCheck.rows[0]!.is_active) {
    throw new Error(`Agent '${targetSlug}' exists but is_active = false. Enable it first.`);
  }

  // Create the child task
  const subTask = await createTask(
    dispatchedBy,
    title,
    description,
    targetSlug,
    parentTaskId
  );

  // Log the dispatch event to shared memory so all agents can observe it
  await writeUnifiedMemory(
    dispatchedBy,
    'agent_called',
    `${dispatchedBy} → ${targetSlug}: ${title}`,
    {
      parent_task_id: parentTaskId,
      sub_task_id: subTask.id,
      dispatched_to: targetSlug,
      title,
    },
    3
  );

  console.log(
    `[registry] Dispatched "${title}" → ${targetSlug} (sub-task ${subTask.id})`
  );

  return { subTaskId: subTask.id, targetAgent: targetSlug };
}

// ---------------------------------------------------------------------------
// Convenience: get a single agent's DB id (re-export for callers)
// ---------------------------------------------------------------------------
export { resolveAgentId };
