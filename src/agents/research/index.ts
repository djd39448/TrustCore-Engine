/**
 * Research Agent — stub sub-agent for web research tasks.
 *
 * In Phase 3 this is a scaffold. Future phases will integrate:
 *  - Ollama LLM calls for summarization
 *  - Web search / scraping tool
 *  - RAG knowledge base ingestion
 */

import { SubAgent, type TaskRecord } from '../base/SubAgent.js';
import { searchKnowledgeBase } from '../../mcp/tools.js';

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

    if (existing.length > 0) {
      await this.remember(
        'observation',
        `Found ${existing.length} relevant KB entries for: ${task.title}`,
        { task_id: task.id, kb_hits: existing.map((e) => e.title) }
      );

      return {
        source: 'knowledge_base',
        hits: existing.length,
        titles: existing.map((e) => e.title),
        note: 'Returned from existing knowledge base. Live search pending LLM integration.',
      };
    }

    // Step 2: No existing knowledge — placeholder for live research
    await this.remember(
      'observation',
      `No KB hits for: ${task.title} — live research not yet implemented`,
      { task_id: task.id }
    );

    return {
      source: 'stub',
      note: 'Live research requires LLM + web search integration (Phase 4).',
      query: task.title,
      description: task.description,
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
