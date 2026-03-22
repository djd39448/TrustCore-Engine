'use client';

import { useEffect, useRef, useState } from 'react';
import { mutate } from 'swr';
import styles from './ChatPanel.module.css';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3003';

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  status?: 'thinking' | 'done' | 'error' | 'timeout';
  taskId?: string;
}

function renderResult(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const r = result as Record<string, unknown>;
  if (typeof r['answer'] === 'string') return r['answer'];
  if (typeof r['body'] === 'string') {
    const subj = typeof r['subject'] === 'string' ? `Subject: ${r['subject']}\n\n` : '';
    return `${subj}${r['body']}`;
  }
  if (typeof r['delegated_to'] === 'string') return `Delegated to ${r['delegated_to']}`;
  if (typeof r['error'] === 'string') return `Error: ${r['error']}`;
  return JSON.stringify(result, null, 2);
}

export default function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 'welcome', role: 'agent', text: 'Hi! I\'m Alex, your chief-of-staff. What can I help you with?', status: 'done' },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', text };
    const thinkingId = crypto.randomUUID();
    const thinkingMsg: ChatMessage = { id: thinkingId, role: 'agent', text: 'Thinking…', status: 'thinking' };
    setMessages((prev) => [...prev, userMsg, thinkingMsg]);

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json() as { taskId: string; status: string; result: unknown; timeout?: boolean };

      let replyText: string;
      let replyStatus: ChatMessage['status'];

      if (data.timeout) {
        replyText = `Still working on it… check task ${data.taskId.slice(0, 8)} in the Tasks tab.`;
        replyStatus = 'timeout';
      } else if (data.status === 'failed') {
        replyText = renderResult(data.result) || 'Task failed.';
        replyStatus = 'error';
      } else {
        replyText = renderResult(data.result) || 'Done.';
        replyStatus = 'done';
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === thinkingId
            ? { ...m, text: replyText, status: replyStatus, taskId: data.taskId }
            : m
        )
      );
      // Refresh task board
      await mutate('/api/tasks?limit=100');
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === thinkingId
            ? { ...m, text: `Error: ${err instanceof Error ? err.message : String(err)}`, status: 'error' }
            : m
        )
      );
    } finally {
      setSending(false);
    }
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Chat with Alex</span>
        <span className={styles.subtitle}>Chief of Staff · messages become tasks · responses from the agent loop</span>
      </div>

      <div className={styles.messages}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={msg.role === 'user' ? `${styles.message} ${styles.userMsg}` : styles.message}
          >
            {msg.role === 'agent' && (
              <span className={styles.avatar}>A</span>
            )}
            <div className={styles.bubble}>
              {msg.status === 'thinking' ? (
                <span className={styles.thinking}>
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                <pre className={styles.text}>{msg.text}</pre>
              )}
              {msg.taskId && msg.status !== 'thinking' && (
                <span className={styles.taskRef}>task {msg.taskId.slice(0, 8)}</span>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className={styles.inputRow}>
        <div className={styles.inputInner}>
          <textarea
            className={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Message Alex… (Enter to send, Shift+Enter for new line)"
            rows={2}
            disabled={sending}
          />
          <button
            className={styles.sendBtn}
            onClick={() => void send()}
            disabled={sending || !input.trim()}
          >
            {sending ? '…' : '↑'}
          </button>
        </div>
      </div>
    </div>
  );
}
