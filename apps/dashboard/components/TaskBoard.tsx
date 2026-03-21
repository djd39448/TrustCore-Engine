'use client';

import { useState } from 'react';
import useSWR, { mutate } from 'swr';
import { fetcher, createTask } from '@/lib/api';
import type { Task } from '@/lib/types';
import styles from './TaskBoard.module.css';

const COLUMNS: { key: Task['status']; label: string; color: string }[] = [
  { key: 'pending', label: 'Pending', color: '#f59e0b' },
  { key: 'in_progress', label: 'In Progress', color: '#3b82f6' },
  { key: 'completed', label: 'Completed', color: '#22c55e' },
  { key: 'failed', label: 'Failed', color: '#ef4444' },
];

function StatusPill({ status }: { status: Task['status'] }) {
  const col = COLUMNS.find((c) => c.key === status);
  return (
    <span className={styles.pill} style={{ background: col?.color ?? '#64748b' }}>
      {col?.label ?? status}
    </span>
  );
}

function TaskCard({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);

  const duration =
    task.started_at && task.completed_at
      ? Math.round(
          (new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()) / 1000
        )
      : null;

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
          </p>
          {duration !== null && (
            <p className={styles.meta}>Duration: <b>{duration}s</b></p>
          )}
          {task.result && (
            <pre className={styles.result}>
              {JSON.stringify(task.result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function NewTaskModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignedTo, setAssignedTo] = useState('alex');
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await createTask(title.trim(), description.trim() || undefined, assignedTo || undefined);
      await mutate('/api/tasks?limit=100');
      onClose();
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
              <option value="alex">Alex (chief)</option>
              <option value="research">Research Agent</option>
              <option value="">Unassigned</option>
            </select>
          </label>
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
