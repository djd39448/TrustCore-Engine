export interface Agent {
  id: string;
  slug: string;
  display_name: string;
  type: 'system' | 'chief' | 'sub-agent';
  description: string;
  is_active: boolean;
  created_at: string;
  last_heartbeat?: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  result: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  created_by: string | null;
  parent_task_title: string | null;
}

export interface MemoryEvent {
  id: string;
  event_type: string;
  summary: string;
  content: Record<string, unknown>;
  importance: number;
  created_at: string;
  agent_slug: string;
  agent_name: string;
}

export interface ToolCall {
  id: string;
  tool_name: string;
  status: 'success' | 'error' | 'timeout';
  duration_ms: number | null;
  created_at: string;
  agent_slug: string;
}

export interface EvalScore {
  id: string;
  task_id: string;
  composite_score: number;
  outcome: 'approved' | 'needs_review' | 'needs_revision';
  technical_correctness: number;
  completeness: number;
  brand_voice: number;
  recipient_personalization: number;
  clarity: number;
  contextual_appropriateness: number;
  dimension_notes: string | null;
  improvement_suggestions: string | null;
  revision_number: number;
  eval_model: string | null;
  created_at: string;
}

export interface WsMessage {
  event: 'connected' | 'task_update' | 'task_created' | 'memory_event';
  data: unknown;
  ts: string;
}
