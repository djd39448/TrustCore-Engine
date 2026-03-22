'use client';

import { useState } from 'react';
import useSWR, { mutate } from 'swr';
import { fetcher, createTask } from '@/lib/api';
import type { Task, Agent } from '@/lib/types';
import styles from './TaskBoard.module.css';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3003';

const COLUMNS: { key: Task['status']; label: string; color: string }[] = [
  { key: 'pending', label: 'Pending', color: '#f59e0b' },
  { key: 'in_progress', label: 'In Progress', color: '#3b82f6' },
  { key: 'completed', label: 'Completed', color: '#22c55e' },
  { key: 'failed', label: 'Failed', color: '#ef4444' },
  { key: 'cancelled', label: 'Cancelled', color: '#64748b' },
];

function StatusPill({ status }: { status: Task['status'] }) {
  const col = COLUMNS.find((c) => c.key === status);
  return (
    <span className={styles.pill} style={{ background: col?.color ?? '#64748b' }}>
      {col?.label ?? status}
    </span>
  );
}

function ResultPanel({ result }: { result: Record<string, unknown> }) {
  // Research result
  if (typeof result['answer'] === 'string') {
    const sources = result['web_sources'] as Array<{ title: string; url: string }> | undefined;
    return (
      <div className={styles.resultPanel}>
        <div className={styles.resultSource}>
          {String(result['source'] ?? 'llm')} · {result['kb_hits'] ? `${result['kb_hits']} KB hits` : ''}{result['web_hits'] ? `${result['web_hits']} web results` : ''}
        </div>
        <p className={styles.resultAnswer}>{result['answer'] as string}</p>
        {sources && sources.length > 0 && (
          <div className={styles.resultSources}>
            {sources.slice(0, 3).map((s, i) => (
              <a key={i} href={s.url} target="_blank" rel="noreferrer" className={styles.sourceLink}>
                {s.title}
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Email result
  if (typeof result['body'] === 'string') {
    return (
      <div className={styles.resultPanel}>
        <div className={styles.resultSource}>email · {result['model'] as string}</div>
        {typeof result['subject'] === 'string' && <p className={styles.emailSubject}>Subject: {result['subject']}</p>}
        <pre className={styles.emailBody}>{result['body'] as string}</pre>
      </div>
    );
  }

  // Delegation result
  if (typeof result['delegated_to'] === 'string') {
    return (
      <div className={styles.resultPanel}>
        <p className={styles.resultMeta}>Delegated to <b>{result['delegated_to'] as string}</b></p>
      </div>
    );
  }

  // Error
  if (typeof result['error'] === 'string') {
    return (
      <div className={styles.resultPanel}>
        <p className={styles.resultError}>{result['error'] as string}</p>
      </div>
    );
  }

  // Fallback: raw JSON
  return (
    <pre className={styles.resultRaw}>{JSON.stringify(result, null, 2)}</pre>
  );
}

function TaskCard({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const duration =
    task.started_at && task.completed_at
      ? Math.round(
          (new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()) / 1000
        )
      : null;

  const canCancel = task.status === 'pending' || task.status === 'in_progress';

  async function handleCancel(e: React.MouseEvent) {
    e.stopPropagation();
    setCancelling(true);
    try {
      await fetch(`${API_BASE}/api/tasks/${task.id}/cancel`, { method: 'PATCH' });
      await mutate('/api/tasks?limit=100');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className={styles.card} onClick={() => setExpanded(!expanded)}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>{task.title}</span>
        {task.assigned_to && <span className={styles.agent}>{task.assigned_to}</span>}
      </div>

      {task.parent_task_title && (
        <p className={styles.parent}>↳ {task.parent_task_title}</p>
      )}

      {expanded && (
        <div className={styles.details}>
          {task.description && <p className={styles.desc}>{task.description}</p>}
          <p className={styles.meta}>
            Created by: <b>{task.created_by ?? 'unknown'}</b>
            {duration !== null && <> · Duration: <b>{duration}s</b></>}
          </p>
          {task.result && <ResultPanel result={task.result} />}
          {canCancel && (
            <button
              className={styles.btnCancelTask}
              onClick={handleCancel}
              disabled={cancelling}
            >
              {cancelling ? 'Cancelling…' : 'Cancel Task'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NewTaskModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data: agents } = useSWR<Agent[]>('/api/agents', fetcher);
  const activeAgents = (agents ?? []).filter((a) => a.is_active);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await createTask(title.trim(), description.trim() || undefined, assignedTo || undefined);
      await mutate('/api/tasks?limit=100');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TaskBoard] createTask failed:', err);
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>New Task</h3>
        <form onSubmit={submit} className={styles.form}>
          <label className={styles.label}>
            Title *
            <input
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              required
              autoFocus
            />
          </label>
          <label className={styles.label}>
            Description
            <textarea
              className={styles.textarea}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional details"
              rows={3}
            />
          </label>
          <label className={styles.label}>
            Assign to
            <select
              className={styles.select}
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
            >
              <option value="">Unassigned</option>
              <option value="dave">Dave (owner)</option>
              {activeAgents.map((agent) => (
                <option key={agent.id} value={agent.slug}>
                  {agent.display_name}
                </option>
              ))}
            </select>
          </label>
          {submitError && <p className={styles.errorMsg}>{submitError}</p>}
          <div className={styles.formActions}>
            <button type="button" className={styles.btnCancel} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={styles.btnSubmit} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function TaskBoard({ liveTaskIds }: { liveTaskIds: Set<string> }) {
  const [showModal, setShowModal] = useState(false);
  const { data: tasks } = useSWR<Task[]>('/api/tasks?limit=100', fetcher, {
    refreshInterval: 5_000,
  });

  const byStatus = (status: Task['status']) =>
    (tasks ?? []).filter((t) => t.status === status);

  return (
    <div className={styles.board}>
      <div className={styles.boardHeader}>
        <h2 className={styles.heading}>Tasks</h2>
        <button className={styles.newBtn} onClick={() => setShowModal(true)}>
          + New Task
        </button>
      </div>

      <div className={styles.columns}>
        {COLUMNS.map((col) => (
          <div key={col.key} className={styles.column}>
            <div className={styles.colHeader} style={{ borderColor: col.color }}>
              <span className={styles.colLabel}>{col.label}</span>
              <span className={styles.colCount}>{byStatus(col.key).length}</span>
            </div>
            <div className={styles.cards}>
              {byStatus(col.key).map((task) => (
                <div
                  key={task.id}
                  className={`${styles.cardWrapper} ${liveTaskIds.has(task.id) ? styles.highlight : ''}`}
                >
                  <TaskCard task={task} />
                </div>
              ))}
              {byStatus(col.key).length === 0 && (
                <p className={styles.empty}>No tasks</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {showModal && <NewTaskModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
