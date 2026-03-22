/**
 * Ollama LLM client — chat completions for agent reasoning and summarization.
 *
 * Uses the same OLLAMA_HOST as the embedding client but calls /api/chat.
 * Gracefully degrades: on failure returns null (callers decide fallback).
 */

function normalizeOllamaHost(raw: string): string {
  let host = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
  host = host.replace('://0.0.0.0', '://localhost');
  // strip trailing slash
  return host.replace(/\/$/, '');
}

const OLLAMA_HOST = normalizeOllamaHost(process.env['OLLAMA_HOST'] ?? 'localhost:11434');
const LLM_MODEL = process.env['LLM_MODEL'] ?? 'qwen2.5-coder:32b';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Send a chat prompt to Ollama. Returns the assistant's reply text, or null on error.
 */
const LLM_TIMEOUT_MS = 120_000;

export async function chat(
  messages: ChatMessage[],
  model: string = LLM_MODEL
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
    console.error(`[LLM] Request timed out after ${LLM_TIMEOUT_MS / 1000}s (model=${model})`);
  }, LLM_TIMEOUT_MS);

  try {
    const url = `${OLLAMA_HOST}/api/chat`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[LLM] Ollama chat error ${response.status}: ${await response.text()}`);
      return null;
    }

    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content ?? null;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[LLM] Chat aborted: timeout after ${LLM_TIMEOUT_MS / 1000}s`);
    } else {
      console.warn('[LLM] Ollama unavailable:', err instanceof Error ? err.message : String(err));
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Simple single-turn prompt — convenience wrapper over chat().
 */
export async function prompt(userPrompt: string, systemPrompt?: string): Promise<string | null> {
  const messages: ChatMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });
  return chat(messages);
}

/**
 * Classify the intent of a task title + description into a known agent type.
 * Returns a slug ('research' | 'alex' | null-if-unknown).
 */
export async function classifyTaskIntent(
  title: string,
  description: string | null
): Promise<string | null> {
  const taskText = description ? `Title: ${title}\nDescription: ${description}` : `Title: ${title}`;

  const result = await prompt(
    taskText,
    `You are a task router for an AI agent system. Given a task, reply with ONLY one of these agent slugs:
- "research" — web research, information lookup, fact-finding, knowledge retrieval
- "email-writer" — drafting emails, writing messages, composing correspondence
- "alex" — orchestration, planning, coordination, general tasks

Reply with just the slug and nothing else. No explanation.`
  );

  if (!result) return null;
  const slug = result.trim().toLowerCase().replace(/[^a-z-]/g, '');
  if (slug === 'research') return 'research';
  if (slug === 'email-writer' || slug === 'emailwriter') return 'email-writer';
  if (slug === 'alex') return 'alex';
  return null;
}
