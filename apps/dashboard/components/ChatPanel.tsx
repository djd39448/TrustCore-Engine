'use client';

import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/lib/api';
import type { ChatSession, ChatMessage } from '@/lib/types';
import styles from './ChatPanel.module.css';

/**
 * UiMessage — local display type for the conversation thread.
 *
 * Extends ChatMessage with two UI-only flags:
 *   typing: true while waiting for Alex's response (shows bouncing dots)
 *   error:  true if the request failed (renders red error bubble)
 *
 * Optimistic user messages use crypto.randomUUID() as id and omit
 * session_id / created_at since they haven't been persisted yet.
 */
interface UiMessage {
  id: string;
  role: 'user' | 'alex';
  content: string;
  typing?: boolean;
  error?: boolean;
}

function formatSessionDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1)  return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffH = Math.floor(diffMins / 60);
  if (diffH < 24)    return `${diffH}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function ChatPanel() {
  const [sessions, setSessions]             = useState<ChatSession[]>([]);
  const [activeId, setActiveId]             = useState<string | null>(null);
  const [messages, setMessages]             = useState<UiMessage[]>([]);
  const [input, setInput]                   = useState('');
  const [sending, setSending]               = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── On mount: load session list ─────────────────────────────
  useEffect(() => {
    void loadSessions();
  }, []);

  // ── Auto-scroll to bottom on new messages ───────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadSessions(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/api/chat/sessions`);
      if (!res.ok) return;
      const data = await res.json() as ChatSession[];
      setSessions(data);
    } catch {
      // ignore — sidebar just stays empty
    }
  }

  // ── New Chat button ──────────────────────────────────────────
  async function handleNewChat(): Promise<void> {
    if (sending) return;
    try {
      const res = await fetch(`${API_BASE}/api/chat/sessions`, {
        method: 'POST',
      });
      if (!res.ok) return;
      const { id } = await res.json() as { id: string };

      // Optimistically prepend to sidebar before reloading from server
      const newSession: ChatSession = {
        id,
        title: 'New conversation',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setSessions((prev) => [newSession, ...prev]);
      setActiveId(id);
      setMessages([]);
    } catch {
      // ignore
    }
  }

  // ── Click an existing session ────────────────────────────────
  async function handleSelectSession(id: string): Promise<void> {
    if (id === activeId || loadingSession) return;
    setActiveId(id);
    setMessages([]);
    setLoadingSession(true);
    try {
      const res = await fetch(`${API_BASE}/api/chat/sessions/${id}/messages`);
      if (!res.ok) { setLoadingSession(false); return; }
      const data = await res.json() as ChatMessage[];
      setMessages(data.map((m) => ({
        id:      m.id,
        role:    m.role,
        content: m.content,
      })));
    } catch {
      // ignore — leave messages empty
    } finally {
      setLoadingSession(false);
    }
  }

  // ── Send a message ───────────────────────────────────────────
  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || sending || !activeId) return;

    setInput('');
    setSending(true);

    // Show user message immediately (optimistic)
    const userMsgId  = crypto.randomUUID();
    const typingId   = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: text },
      { id: typingId,  role: 'alex', content: '',  typing: true },
    ]);

    // Update session title in sidebar if this is the first message
    // (the server will have auto-set it; sync our local copy)
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId && s.title === 'New conversation'
          ? { ...s, title: text.slice(0, 60), updated_at: new Date().toISOString() }
          : s.id === activeId
          ? { ...s, updated_at: new Date().toISOString() }
          : s
      )
    );

    try {
      // ⚠ 5-minute timeout — Ollama may need time to load the model into VRAM.
      // The typing indicator will remain visible for the full duration.
      // Do NOT reduce this timeout. Default browser fetch has no timeout
      // but AbortSignal.timeout gives us a hard ceiling of 300s.
      const res = await fetch(`${API_BASE}/api/chat/message`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ session_id: activeId, message: text }),
        signal:  AbortSignal.timeout(300_000), // 5 minutes
      });

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === typingId
              ? { ...m, typing: false, error: true, content: err.error ?? `API error ${res.status}` }
              : m
          )
        );
        return;
      }

      const data = await res.json() as { response: string | null; session_id: string };
      const reply = data.response ?? "I didn't receive a response. Please try again.";

      setMessages((prev) =>
        prev.map((m) =>
          m.id === typingId
            ? { ...m, typing: false, content: reply }
            : m
        )
      );

      // Re-fetch session list so sidebar reflects updated titles and ordering
      void loadSessions();
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      const errMsg = isTimeout
        ? "Response timed out after 5 minutes. Alex may be overloaded — please try again."
        : `Error: ${err instanceof Error ? err.message : String(err)}`;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === typingId
            ? { ...m, typing: false, error: true, content: errMsg }
            : m
        )
      );
    } finally {
      setSending(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const activeSession = sessions.find((s) => s.id === activeId);

  return (
    <div className={styles.panel}>

      {/* ── Left sidebar ──────────────────────────────────────── */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <button
            className={styles.newChatBtn}
            onClick={() => void handleNewChat()}
            disabled={sending}
          >
            <span className={styles.newChatIcon}>+</span>
            New Chat
          </button>
        </div>

        <div className={styles.sidebarDivider} />

        <div className={styles.sessionList}>
          {sessions.length === 0 && (
            <p className={styles.sessionListEmpty}>No conversations yet</p>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`${styles.sessionItem} ${s.id === activeId ? styles.sessionItemActive : ''}`}
              onClick={() => void handleSelectSession(s.id)}
            >
              <span className={styles.sessionTitle}>{s.title}</span>
              <span className={styles.sessionDate}>{formatSessionDate(s.updated_at)}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* ── Main conversation area ─────────────────────────────── */}
      <div className={styles.conversation}>
        {!activeId ? (
          // No session selected
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>◈</span>
            <p className={styles.emptyText}>Select a conversation or start a new one</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className={styles.convHeader}>
              <span className={styles.convTitle}>
                {activeSession?.title ?? 'Chat'}
              </span>
              <span className={styles.convSubtitle}>Alex · Chief of Staff</span>
            </div>

            {/* Message thread */}
            <div className={styles.messages}>
              {loadingSession && (
                <div className={styles.message}>
                  <span className={styles.avatar}>A</span>
                  <div className={styles.bubble}>
                    <div className={styles.typing}>
                      <span /><span /><span />
                    </div>
                  </div>
                </div>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`${styles.message} ${msg.role === 'user' ? styles.userMsg : ''}`}
                >
                  {/* Alex avatar — only on Alex messages */}
                  {msg.role === 'alex' && (
                    <span className={styles.avatar}>A</span>
                  )}

                  <div className={styles.bubble}>
                    {msg.typing ? (
                      <div className={styles.typing}>
                        <span /><span /><span />
                      </div>
                    ) : msg.error ? (
                      <pre className={styles.errorText}>{msg.content}</pre>
                    ) : msg.role === 'user' ? (
                      <pre className={styles.userText}>{msg.content}</pre>
                    ) : (
                      <pre className={styles.text}>{msg.content}</pre>
                    )}
                  </div>
                </div>
              ))}

              <div ref={bottomRef} />
            </div>

            {/* Input bar */}
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
          </>
        )}
      </div>

    </div>
  );
}
