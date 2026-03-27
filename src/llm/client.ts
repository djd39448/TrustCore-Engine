/**
 * Ollama LLM client — chat completions for agent reasoning and summarization.
 *
 * All calls are routed through the resource manager priority queue:
 *   Priority 1 — alex routing decisions
 *   Priority 2 — sub-agent task execution  (default)
 *   Priority 3 — embeddings (handled in embedding/client.ts)
 *   Priority 4 — factory requests
 *
 * Gracefully degrades: on failure returns null (callers decide fallback).
 */

import { enqueue, type Priority } from '../resource-manager/queue.js';

function normalizeOllamaHost(raw: string): string {
  let host = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
  host = host.replace('://0.0.0.0', '://localhost');
  return host.replace(/\/$/, '');
}

const OLLAMA_HOST = normalizeOllamaHost(process.env['OLLAMA_HOST'] ?? 'localhost:11434');
export const LLM_MODEL = process.env['LLM_MODEL'] ?? 'qwen2.5-coder:32b';
// Keep context window small so the 14b model fits entirely in VRAM (no CPU spill).
// 4096 is sufficient for task routing, classification, and short summarization.
const OLLAMA_NUM_CTX = parseInt(process.env['OLLAMA_NUM_CTX'] ?? '4096');

/**
 * OLLAMA_KEEP_ALIVE — per-request model lifetime hint, passed in the request body.
 *
 * Ollama respects the keep_alive field in the request body, giving each agent
 * explicit control over how long the model stays resident in VRAM after the
 * response completes. This is separate from, and overrides, the server-level
 * OLLAMA_KEEP_ALIVE environment variable on the Ollama container.
 *
 * Passing it per-request ensures the policy is enforced even if the Ollama
 * container restarts with a different default.
 *
 * Values (Ollama format):
 *   "0"   — unload model immediately after response (gpu0: email-writer, eval)
 *   "-1"  — keep model loaded indefinitely (gpu1: alex)
 *   "5m"  — keep for 5 minutes, then unload
 *
 * If the env var is not set (undefined), the field is omitted from the request
 * body and Ollama falls back to its server-level default.
 */
const OLLAMA_KEEP_ALIVE = process.env['OLLAMA_KEEP_ALIVE'];

// Approximate VRAM requirements by model name pattern (GB)
const MODEL_SIZE_MAP: [RegExp, number][] = [
  [/70b/i, 40],
  [/35b/i, 22],
  [/32b/i, 20],
  [/14b/i, 9],
  [/9b/i, 6],
  [/7b/i, 5],
  [/3b/i, 2],
  [/1b|0\.5b/i, 1],
];

function estimateModelSizeGB(modelName: string): number {
  for (const [pattern, size] of MODEL_SIZE_MAP) {
    if (pattern.test(modelName)) return size;
  }
  return 8; // conservative default
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaToolParameter {
  type: string;
  description?: string;
  enum?: string[];
}

export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, OllamaToolParameter>;
      required?: string[];
    };
  };
}

export interface OllamaToolCall {
  id: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Raw fetch to Ollama — no queue, used internally by the queued wrapper.
 */
async function fetchChat(messages: ChatMessage[], model: string): Promise<string | null> {
  const controller = new AbortController();
  // Allow up to 300s — large models (9b+) need time to swap into VRAM from disk
  const timer = setTimeout(() => controller.abort(), 300_000);

  try {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { num_ctx: OLLAMA_NUM_CTX },
        // keep_alive instructs Ollama to unload (or keep) the model after this
        // specific request, regardless of the server's default setting.
        // "0" on gpu0 agents ensures the model is evicted immediately, freeing
        // VRAM for the next task. "-1" on Alex's gpu1 keeps the 14b model hot.
        ...(OLLAMA_KEEP_ALIVE !== undefined ? { keep_alive: OLLAMA_KEEP_ALIVE } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[LLM] Ollama error ${response.status}: ${await response.text()}`);
      return null;
    }

    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content ?? null;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[LLM] Request timed out (model=${model})`);
    } else {
      console.warn('[LLM] Ollama unavailable:', err instanceof Error ? err.message : String(err));
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Raw fetch to Ollama with tools — no queue, used internally.
 */
async function fetchChatWithTools(
  messages: ChatMessage[],
  tools: OllamaTool[],
  model: string
): Promise<{ content: string | null; toolCalls: OllamaToolCall[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);

  try {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: false,
        options: { num_ctx: OLLAMA_NUM_CTX },
        ...(OLLAMA_KEEP_ALIVE !== undefined
          ? { keep_alive: OLLAMA_KEEP_ALIVE } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[LLM] chatWithTools error ${response.status}`);
      return { content: null, toolCalls: [] };
    }

    const data = await response.json() as {
      message?: {
        content?: string;
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: Record<string, unknown> }
        }>
      }
    };

    return {
      content: data.message?.content ?? null,
      toolCalls: (data.message?.tool_calls ?? []).map(tc => ({
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[LLM] chatWithTools timed out (model=${model})`);
    } else {
      console.warn('[LLM] chatWithTools unavailable:',
        err instanceof Error ? err.message : String(err));
    }
    return { content: null, toolCalls: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a chat prompt through the priority queue.
 * Returns the assistant reply text, or null on failure.
 *
 * @param messages  Chat messages
 * @param model     Model name (defaults to LLM_MODEL env var)
 * @param priority  Queue priority (default 2 = agent_execution)
 * @param label     Human-readable label for queue logging
 */
export async function chat(
  messages: ChatMessage[],
  model: string = LLM_MODEL,
  priority: Priority = 2,
  label = 'chat'
): Promise<string | null> {
  const modelSizeGB = estimateModelSizeGB(model);
  try {
    return await enqueue(priority, label, model, modelSizeGB, () => fetchChat(messages, model));
  } catch (err) {
    console.error('[LLM] Queue rejected request:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Send a chat prompt with tool definitions. The model may respond
 * with plain text OR a tool_calls array. Returns both so the caller
 * can dispatch tool execution.
 *
 * @param messages  Chat messages including system prompt
 * @param tools     Tool definitions in Ollama function-calling format
 * @param model     Model name (must support tool calling)
 * @param priority  Queue priority (default 1 — alex routing)
 * @param label     Human-readable label for queue logging
 */
export async function chatWithTools(
  messages: ChatMessage[],
  tools: OllamaTool[],
  model: string = LLM_MODEL,
  priority: Priority = 1,
  label = 'chat-with-tools'
): Promise<{ content: string | null; toolCalls: OllamaToolCall[] }> {
  const modelSizeGB = estimateModelSizeGB(model);
  try {
    const result = await enqueue(priority, label, model, modelSizeGB,
      () => fetchChatWithTools(messages, tools, model)
    );
    return result;
  } catch (err) {
    console.error('[LLM] chatWithTools queue rejected:',
      err instanceof Error ? err.message : String(err));
    return { content: null, toolCalls: [] };
  }
}

/**
 * Simple single-turn prompt — convenience wrapper over chat().
 */
export async function prompt(
  userPrompt: string,
  systemPrompt?: string,
  priority: Priority = 2
): Promise<string | null> {
  const messages: ChatMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });
  return chat(messages, LLM_MODEL, priority, userPrompt.slice(0, 60));
}

/**
 * Classify task intent — uses priority 1 (alex routing).
 */
export async function classifyTaskIntent(
  title: string,
  description: string | null
): Promise<string | null> {
  const taskText = description ? `Title: ${title}\nDescription: ${description}` : `Title: ${title}`;

  const result = await chat(
    [
      {
        role: 'system',
        content: `You are a task router for an AI agent system. Given a task, reply with ONLY one of these agent slugs:
- "research" — web research, information lookup, fact-finding, knowledge retrieval, summarizing external sources
- "email-writer" — drafting and sending emails TO a specific named recipient (requires: recipient name, recipient company, clear goal). Do NOT use for writing documents, mission statements, reports, or content without a named recipient.
- "alex" — orchestration, planning, coordination, general tasks, writing documents, drafting internal content, mission statements, summaries, reports, analysis

Examples of correct routing:
  "Write an email to John Smith at Acme Corp" → email-writer
  "Draft a mission statement for TrustCore" → alex
  "Research family trust structures in Ohio" → research
  "Write a cold outreach to Sarah at Google" → email-writer
  "Summarize our Q2 goals" → alex
  "Look up best practices for asset protection" → research
  "Draft an email introducing TrustCore to investors" → email-writer
  "Create a one-page overview of TrustCore" → alex

Reply with just the slug and nothing else. No explanation.`,
      },
      { role: 'user', content: taskText },
    ],
    LLM_MODEL,
    1,  // priority 1: alex routing
    `classify:${title.slice(0, 40)}`
  );

  if (!result) return null;
  const slug = result.trim().toLowerCase().replace(/[^a-z-]/g, '');
  if (slug === 'research') return 'research';
  if (slug === 'email-writer' || slug === 'emailwriter') return 'email-writer';
  if (slug === 'alex') return 'alex';
  return null;
}
