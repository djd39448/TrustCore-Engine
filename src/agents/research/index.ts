/**
 * Research Agent — answers research questions via KB lookup + LLM reasoning.
 *
 * Pipeline:
 *  1. Search knowledge base for relevant existing entries (RAG)
 *  2. Use Ollama LLM to synthesize a research answer, injecting KB context when available
 *  3. Log answer to agent_memory and unified_memory
 */

import { SubAgent, type TaskRecord } from '../base/SubAgent.js';
import { searchKnowledgeBase } from '../../mcp/tools.js';
import { prompt } from '../../llm/client.js';
import { webSearch, type SearchResult } from '../../tools/webSearch.js';

const RESEARCH_SYSTEM = `You are a research assistant. Answer the user's question concisely and accurately.
When you have context from a knowledge base or web search results, use it to ground your answer.
If you don't know something, say so clearly. Do not hallucinate facts.
Respond in plain prose — no bullet lists unless the question asks for them.`;

class ResearchAgent extends SubAgent {
  constructor() {
    super('research', 'Research Agent', 30_000);
  }

  async handleTask(task: TaskRecord): Promise<unknown> {
    // Step 1: Check if we already have relevant knowledge
    const existing = await this.instrument(
      'search_knowledge_base',
      { query: task.title },
      () => searchKnowledgeBase(task.title, this.slug, 5),
      task.id
    ) as Awaited<ReturnType<typeof searchKnowledgeBase>>;

    // Step 2: Web search when KB has no hits
    let webResults: SearchResult[] = [];
    if (existing.length === 0) {
      webResults = await this.instrument(
        'web_search',
        { query: task.title },
        () => webSearch(task.title, 5),
        task.id
      ) as SearchResult[];
      if (webResults.length > 0) {
        console.log(`[Research Agent] Web search returned ${webResults.length} results`);
      }
    }

    // Step 3: Build prompt — inject KB or web context
    let userPrompt = task.description
      ? `${task.title}\n\n${task.description}`
      : task.title;

    if (existing.length > 0) {
      const context = existing
        .map((e, i) => `[${i + 1}] ${e.title}:\n${e.content ?? ''}`)
        .join('\n\n');
      userPrompt = `Context from knowledge base:\n${context}\n\nQuestion: ${userPrompt}`;
      await this.remember(
        'observation',
        `Found ${existing.length} KB entries for: ${task.title}`,
        { task_id: task.id, kb_hits: existing.map((e) => e.title) }
      );
    } else if (webResults.length > 0) {
      const context = webResults
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`)
        .join('\n\n');
      userPrompt = `Web search results for "${task.title}":\n${context}\n\nQuestion: ${userPrompt}`;
      await this.remember(
        'observation',
        `Web search returned ${webResults.length} results for: ${task.title}`,
        { task_id: task.id, urls: webResults.map((r) => r.url) }
      );
    }

    // Step 3: Call LLM
    const answer = await this.instrument(
      'llm_research',
      { query: task.title },
      () => prompt(userPrompt, RESEARCH_SYSTEM, 2),
      task.id
    ) as string | null;

    if (!answer) {
      await this.remember('observation', `LLM unavailable for: ${task.title}`, { task_id: task.id });
      return {
        source: 'llm_unavailable',
        note: 'LLM did not respond — Ollama may be busy or offline.',
        query: task.title,
      };
    }

    await this.remember(
      'observation',
      `Research complete: ${task.title}`,
      { task_id: task.id, answer_preview: answer.slice(0, 200) }
    );

    await this.log(
      'task_completed',
      `Research answer generated for: ${task.title}`,
      { task_id: task.id, kb_hits: existing.length, answer_length: answer.length }
    );

    const source = existing.length > 0 ? 'kb+llm' : webResults.length > 0 ? 'web+llm' : 'llm';
    return {
      source,
      answer,
      kb_hits: existing.length,
      web_hits: webResults.length,
      web_sources: webResults.map((r) => ({ title: r.title, url: r.url })),
    };
  }
}

async function main(): Promise<void> {
  const agent = new ResearchAgent();
  await agent.start();
}

main().catch((err) => {
  console.error('[Research] Fatal:', err);
  process.exit(1);
});
