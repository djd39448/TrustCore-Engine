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

/**
 * ASBCP (Agent Schema Based Communication Protocol) — @asbcp/core
 *
 * When Alex dispatches a task using the ASBCP protocol, the description
 * field is a serialised TaskMessage JSON string. We use validate() to
 * detect this format, parse it, and extract the intent.payload as the
 * schema — keeping the same validation guarantee at both ends of the wire.
 *
 * The email-writer continues to accept the legacy flat email-outreach schema
 * format (plain JSON with type === 'email-outreach') for backwards compatibility.
 * New dispatches from Alex will always use the ASBCP format.
 */
import { validate as validateASBCP, type TaskMessage } from '@asbcp/core';

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
    // Schema parsing — description may be either:
    //   A) A validated ASBCP TaskMessage (from Alex ≥ ASBCP integration)
    //      Detection: parsed JSON has asbcp_version === '1.0' and message_type === 'task'
    //      Intent fields live in message.intent.payload; constraints in message.intent.constraints
    //      Strategic notes from Alex (enrichment.notes) are logged but not injected into prompts —
    //      they inform the agent but the LLM prompt is driven by the schema fields directly.
    //
    //   B) A legacy flat email-outreach schema (from Alex < ASBCP integration)
    //      Detection: parsed JSON has type === 'email-outreach'
    //      Handled exactly as before for backwards compatibility.
    //
    //   C) Plain-text description — used as-is (no structured schema)
    // -------------------------------------------------------------------------
    let schema: Record<string, unknown> | null = null;
    let effectiveDescription = task.description;
    let enrichmentNotes: string | null = null;

    if (task.description) {
      try {
        const parsed = JSON.parse(task.description) as Record<string, unknown>;

        // --- Path A: ASBCP TaskMessage ---
        if (parsed['asbcp_version'] === '1.0' && parsed['message_type'] === 'task') {
          // Validate through the SDK so we get typed access and a clear error if malformed.
          const validationResult = validateASBCP(parsed);
          if (validationResult.success && validationResult.data.message_type === 'task') {
            // Explicit cast to TaskMessage: TypeScript can't chain narrowing through
            // both the ValidationResult discriminant and the message_type discriminant
            // in a single expression, so we assert here after confirming both.
            const msg = validationResult.data as TaskMessage;
            const payload = msg.intent.payload as Record<string, unknown>;

            // Reconstruct the email-outreach schema shape from the ASBCP payload.
            // intent.type is the task type; payload carries the domain-specific fields.
            // intent.constraints carries the hard constraints array.
            schema = {
              type: msg.intent.type,        // e.g. 'email-outreach'
              ...payload,                   // recipient, goal, tone, length, etc.
              constraints: msg.intent.constraints ?? [],
              eval: msg.intent.eval_type
                ? { type: msg.intent.eval_type, priority: msg.intent.priority }
                : undefined,
            };

            // Log Alex's strategic notes to memory — useful for debugging and DPO later.
            // We do NOT inject them directly into LLM prompts to keep the intent layer sacred.
            if (msg.enrichment?.notes) {
              enrichmentNotes = msg.enrichment.notes;
              await this.remember(
                'observation',
                `Email Writer received enrichment from Alex (msg ${msg.message_id})`,
                {
                  task_id: task.id,
                  asbcp_message_id: msg.message_id,
                  enrichment_notes: enrichmentNotes,
                  context_sources: msg.enrichment.context_sources,
                }
              );
            }
          } else if (!validationResult.success) {
            // ASBCP message was malformed — log and fall through to plain-text handling
            await this.remember(
              'observation',
              `Email Writer: received malformed ASBCP message (validation failed), falling back to description`,
              { task_id: task.id, errors: validationResult.error.flatten().fieldErrors }
            );
          }

        // --- Path B: Legacy flat email-outreach schema ---
        } else if (parsed['type'] === 'email-outreach') {
          schema = parsed;
        }

        // Path C: JSON that is neither ASBCP nor email-outreach — treat as plain text (fall-through)

      } catch {
        // Plain-text description — use as-is
      }
    }

    if (schema) {
      const recipient = schema['recipient'] as Record<string, string> | undefined;
      const missingFields: string[] = [];

      // All three recipient identifiers are empty — we have no idea who to write to
      if (!recipient?.['name'] && !recipient?.['role'] && !recipient?.['company']) {
        missingFields.push('recipient (name, role, and company are all empty)');
      }
      if (!schema['goal']) missingFields.push('goal');

      if (missingFields.length > 0) {
        await this.remember('observation',
          `Email Writer: flagging incomplete schema — missing: ${missingFields.join(', ')}`,
          { task_id: task.id, missing_fields: missingFields }
        );
        return {
          flagged: true,
          reason: `Cannot draft email — required schema fields are empty: ${missingFields.join(', ')}. ` +
            `Please provide recipient details and a clear goal.`,
          missing_fields: missingFields,
          source: 'validation_error',
        };
      }

      // Build a rich human-readable description for the LLM draft step
      const r = recipient ?? {};
      effectiveDescription = [
        `Goal: ${schema['goal']}`,
        r['name'] ? `Recipient name: ${r['name']}` : null,
        r['role'] ? `Recipient role: ${r['role']}` : null,
        r['company'] ? `Recipient company: ${r['company']}` : null,
        r['relationship'] ? `Relationship: ${r['relationship']}` : null,
        r['context'] ? `Context: ${r['context']}` : null,
        schema['tone'] ? `Tone: ${schema['tone']}` : null,
        schema['length'] ? `Target length: ${schema['length']}` : null,
        (schema['constraints'] as string[] | undefined)?.length
          ? `Constraints: ${(schema['constraints'] as string[]).join('; ')}` : null,
      ].filter(Boolean).join('\n');
    }

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
          (effectiveDescription ? `\n\nAdditional requirements:\n${effectiveDescription}` : ''),
      });
    } else {
      draftMessages.push({
        role: 'user',
        content: `Write an email for: ${task.title}` +
          (effectiveDescription ? `\n\nAdditional requirements:\n${effectiveDescription}` : ''),
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
        content: `Original brief: "${task.title}"` +
        (effectiveDescription ? `\n\nRequirements:\n${effectiveDescription}` : '') +
        `\n\nDraft to review and improve:\n\n${draft}`,
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
