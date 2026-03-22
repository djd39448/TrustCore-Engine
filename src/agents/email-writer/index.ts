/**
 * Email Writer sub-agent.
 *
 * Specializes in drafting professional emails from a brief description.
 * Extends SubAgent so it automatically:
 *   - Polls for tasks assigned to 'email-writer'
 *   - Logs every step to unified_memory and agent_memory
 *   - Reports completion/failure back to Alex via updateTask
 *
 * Workflow for each task:
 *   1. Research step: search KB for relevant context
 *   2. Draft step: call LLM to write the email
 *   3. Review step: call LLM to self-critique and improve
 *   4. Return final draft
 *
 * The three-step workflow mirrors how a human professional would work —
 * gather context, draft, then review — and produces noticeably better
 * output than a single LLM call.
 */

import { SubAgent, type TaskRecord } from '../base/SubAgent.js';
import { chat, type ChatMessage } from '../../llm/client.js';
import { searchKnowledgeBase } from '../../mcp/tools.js';
import { webSearch } from '../../tools/webSearch.js';
import { config } from '../../config.js';

// Email writer uses a smaller/faster model when configured separately.
// Falls back to the global LLM model.
const EMAIL_MODEL = process.env['EMAIL_WRITER_MODEL'] ?? config.llmModel;

/**
 * EmailWriterAgent — turns a task brief into a polished email draft.
 */
export class EmailWriterAgent extends SubAgent {
  constructor() {
    super('email-writer', 'Email Writer', config.researchPollMs);
  }

  /**
   * Main task handler. Receives a TaskRecord where:
   *   - task.title = subject or one-line brief (e.g. "Welcome email for new TrustCore user")
   *   - task.description = optional additional context/requirements
   *
   * Returns an object with { subject, body, model } so Alex can relay it.
   */
  async handleTask(task: TaskRecord): Promise<unknown> {
    // -------------------------------------------------------------------------
    // Step 1: Research — look up any relevant KB context
    // -------------------------------------------------------------------------
    await this.remember(
      'workflow_step',
      `Email Writer: starting research for "${task.title}"`,
      { task_id: task.id, step: 'research' }
    );

    const kbResults = await this.instrument(
      'searchKnowledgeBase',
      { query: task.title, agent: 'email-writer', limit: 3 },
      async () => searchKnowledgeBase(task.title, 'email-writer', 3),
      task.id
    ) as Awaited<ReturnType<typeof searchKnowledgeBase>>;

    // If no KB hits, try web search for context
    let context: string | null = null;
    if (kbResults.length > 0) {
      context = kbResults.map((r) => r.content).join('\n\n---\n\n');
    } else {
      const webResults = await this.instrument(
        'web_search',
        { query: task.title },
        () => webSearch(task.title, 3),
        task.id
      ) as Awaited<ReturnType<typeof webSearch>>;

      if (webResults.length > 0) {
        context = webResults
          .map((r) => `${r.title}: ${r.snippet}`)
          .join('\n\n');
        await this.remember(
          'observation',
          `Web search found ${webResults.length} results for email context`,
          { task_id: task.id, web_hits: webResults.length }
        );
      }
    }

    await this.remember(
      'observation',
      `Research found ${kbResults.length} KB entries for email task`,
      { task_id: task.id, kb_hits: kbResults.length }
    );

    // -------------------------------------------------------------------------
    // Step 2: Draft — generate the initial email
    // -------------------------------------------------------------------------
    await this.remember(
      'workflow_step',
      `Email Writer: drafting email for "${task.title}"`,
      { task_id: task.id, step: 'draft' }
    );

    const draftMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a professional email writer. Write clear, concise, and engaging emails. ' +
          'Format your output as:\nSubject: <subject line>\n\n<email body>',
      },
    ];

    if (context) {
      draftMessages.push({
        role: 'user',
        content: `Relevant context:\n${context}\n\n---\n\nWrite an email for: ${task.title}` +
          (task.description ? `\n\nAdditional requirements: ${task.description}` : ''),
      });
    } else {
      draftMessages.push({
        role: 'user',
        content: `Write an email for: ${task.title}` +
          (task.description ? `\n\nAdditional requirements: ${task.description}` : ''),
      });
    }

    const draft = await this.instrument(
      'llm_draft_email',
      { model: EMAIL_MODEL, task: task.title },
      async () => chat(draftMessages, EMAIL_MODEL),
      task.id
    ) as string | null;

    if (!draft) {
      // LLM unavailable — return a stub so the task doesn't fail silently
      const stub = {
        subject: task.title,
        body: `[Email draft unavailable — LLM (${EMAIL_MODEL}) is offline. Please retry when Ollama is running.]`,
        model: 'stub',
        kb_context_used: kbResults.length > 0,
      };
      await this.remember('observation', 'Email draft failed: LLM unavailable', { task_id: task.id });
      return stub;
    }

    // -------------------------------------------------------------------------
    // Step 3: Review — self-critique and improve the draft
    // -------------------------------------------------------------------------
    await this.remember(
      'workflow_step',
      `Email Writer: reviewing draft for "${task.title}"`,
      { task_id: task.id, step: 'review' }
    );

    const reviewMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a senior editor reviewing an email draft. ' +
          'Review the draft for tone, clarity, and completeness. ' +
          'Return the improved final version only, no commentary. ' +
          'Keep the Subject: line format.',
      },
      {
        role: 'user',
        content: `Original brief: "${task.title}"\n\nDraft to review and improve:\n\n${draft}`,
      },
    ];

    const finalDraft = await this.instrument(
      'llm_review_email',
      { model: EMAIL_MODEL },
      async () => chat(reviewMessages, EMAIL_MODEL),
      task.id
    ) as string | null;

    const emailText = finalDraft ?? draft;

    // Parse subject line out of the formatted output
    const lines = emailText.split('\n');
    const subjectLine = lines.find((l) => l.startsWith('Subject:'));
    const subject = subjectLine ? subjectLine.replace('Subject:', '').trim() : task.title;
    const bodyStart = subjectLine ? lines.indexOf(subjectLine) + 1 : 0;
    const body = lines.slice(bodyStart).join('\n').trim();

    await this.remember(
      'observation',
      `Email Writer: completed draft for "${task.title}"`,
      { task_id: task.id, subject, chars: body.length, reviewed: finalDraft !== null }
    );

    return {
      subject,
      body,
      model: EMAIL_MODEL,
      kb_context_used: kbResults.length > 0,
      reviewed: finalDraft !== null,
    };
  }
}

// ---------------------------------------------------------------------------
// Entry point (when run directly: node ... src/agents/email-writer/index.ts)
// ---------------------------------------------------------------------------

const agent = new EmailWriterAgent();
agent.start().catch((err) => {
  console.error('[EmailWriter] Fatal error:', err);
  process.exit(1);
});
