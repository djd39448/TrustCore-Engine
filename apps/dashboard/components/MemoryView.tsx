'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import type { MemoryEvent } from '@/lib/types';
import styles from './MemoryView.module.css';

const EVENT_COLOR: Record<string, string> = {
  task_started: '#3b82f6',
  task_completed: '#22c55e',
  task_failed: '#ef4444',
  agent_called: '#a855f7',
  user_interaction: '#f59e0b',
  observation: '#64748b',
  consolidation_summary: '#0ea5e9',
  heartbeat: '#10b981',
};

const IMPORTANCE_LABEL = ['', 'Low', 'Low', 'Med', 'High', 'Critical'];
const IMPORTANCE_COLOR = ['', '#64748b', '#64748b', '#f59e0b', '#f97316', '#ef4444'];

const PAGE_SIZE = 50;

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleString();
}

function MemoryRow({ event }: { event: MemoryEvent }) {
  const [expanded, setExpanded] = useState(false);
  const color = EVENT_COLOR[event.event_type] ?? '#64748b';

  return (
    <div className={styles.row} onClick={() => setExpanded(!expanded)}>
      <div className={styles.rowHeader}>
        <span className={styles.dot} style={{ background: color }} />
        <span className={styles.eventType} style={{ color }}>
          {event.event_type}
        </span>
        <span className={styles.agentBadge}>{event.agent_slug}</span>
        <span
          className={styles.impBadge}
          style={{ color: IMPORTANCE_COLOR[event.importance] ?? '#64748b' }}
        >
          {IMPORTANCE_LABEL[event.importance] ?? event.importance}
        </span>
        <span className={styles.time}>{relativeTime(event.created_at)}</span>
        <span className={styles.chevron}>{expanded ? '▲' : '▼'}</span>
      </div>
      <p className={styles.summary}>{event.summary}</p>
      {expanded && (
        <pre className={styles.content}>{JSON.stringify(event.content, null, 2)}</pre>
      )}
    </div>
  );
}

export default function MemoryView() {
  const [page, setPage] = useState(0);
  const [agentFilter, setAgentFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');

  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
    ...(agentFilter ? { agent: agentFilter } : {}),
    ...(typeFilter ? { event_type: typeFilter } : {}),
  });

  const { data: events, error } = useSWR<MemoryEvent[]>(
    `/api/memories?${params.toString()}`,
    fetcher,
    { refreshInterval: 10_000 }
  );

  const filtered = (events ?? []).filter((e) =>
    search ? e.summary.toLowerCase().includes(search.toLowerCase()) : true
  );

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <input
          className={styles.searchInput}
          placeholder="Search summaries…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className={styles.filter}
          value={agentFilter}
          onChange={(e) => { setAgentFilter(e.target.value); setPage(0); }}
        >
          <option value="">All agents</option>
          <option value="alex">Alex</option>
          <option value="system">System</option>
          <option value="email-writer">Email Writer</option>
          <option value="research">Research</option>
        </select>
        <select
          className={styles.filter}
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }}
        >
          <option value="">All types</option>
          <option value="heartbeat">heartbeat</option>
          <option value="task_started">task_started</option>
          <option value="task_completed">task_completed</option>
          <option value="task_failed">task_failed</option>
          <option value="observation">observation</option>
          <option value="consolidation_summary">consolidation_summary</option>
          <option value="agent_called">agent_called</option>
          <option value="user_interaction">user_interaction</option>
        </select>
      </div>

      {error && <p className={styles.error}>Failed to load memories</p>}
      {!events && !error && <p className={styles.muted}>Loading…</p>}

      <div className={styles.list}>
        {filtered.length === 0 && events && (
          <p className={styles.empty}>No memory records match the current filters.</p>
        )}
        {filtered.map((ev) => (
          <MemoryRow key={ev.id} event={ev} />
        ))}
      </div>

      <div className={styles.pagination}>
        <button
          className={styles.pageBtn}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
        >
          ← Prev
        </button>
        <span className={styles.pageLabel}>Page {page + 1}</span>
        <button
          className={styles.pageBtn}
          onClick={() => setPage((p) => p + 1)}
          disabled={(events?.length ?? 0) < PAGE_SIZE}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
