'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import type { Agent, MemoryEvent } from '@/lib/types';
import styles from './AgentsView.module.css';

const TYPE_COLOR: Record<string, string> = {
  chief: '#6366f1',
  'sub-agent': '#10b981',
  system: '#64748b',
};

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function AgentMemoryDrawer({ slug }: { slug: string }) {
  const { data, error } = useSWR<MemoryEvent[]>(
    `/api/agents/${slug}/memories`,
    fetcher,
    { refreshInterval: 15_000 }
  );

  if (error) return <p className={styles.drawerError}>Failed to load memories</p>;
  if (!data) return <p className={styles.drawerMuted}>Loading…</p>;
  if (data.length === 0) return <p className={styles.drawerMuted}>No memory records yet.</p>;

  return (
    <ul className={styles.drawerList}>
      {data.map((ev) => (
        <li key={ev.id} className={styles.drawerItem}>
          <span className={styles.drawerType}>{ev.event_type}</span>
          <span className={styles.drawerSummary}>{ev.summary}</span>
          <span className={styles.drawerTime}>{relativeTime(ev.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

interface AgentWithStats extends Agent {
  model?: string;
  last_heartbeat?: string | null;
  tasks_completed?: number;
}

export default function AgentsView() {
  const { data: agents, error } = useSWR<AgentWithStats[]>('/api/agents', fetcher, {
    refreshInterval: 15_000,
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggle = (slug: string) => setExpanded((prev) => (prev === slug ? null : slug));

  return (
    <div className={styles.view}>
      <h2 className={styles.heading}>Registered Agents</h2>

      {error && <p className={styles.error}>Failed to load agents</p>}
      {!agents && !error && <p className={styles.muted}>Loading…</p>}

      <div className={styles.list}>
        {agents?.map((agent) => (
          <div key={agent.id} className={styles.card}>
            <div className={styles.cardHeader} onClick={() => toggle(agent.slug)}>
              <div className={styles.cardLeft}>
                <span
                  className={styles.typeBadge}
                  style={{ background: TYPE_COLOR[agent.type] ?? '#64748b' }}
                >
                  {agent.type}
                </span>
                <span className={styles.name}>{agent.display_name}</span>
                <span
                  className={styles.statusDot}
                  style={{ background: agent.is_active ? '#22c55e' : '#ef4444' }}
                  title={agent.is_active ? 'Active' : 'Inactive'}
                />
              </div>
              <div className={styles.cardRight}>
                {agent.model && (
                  <span className={styles.model}>{agent.model}</span>
                )}
                <span className={styles.chevron}>
                  {expanded === agent.slug ? '▲' : '▼'}
                </span>
              </div>
            </div>

            <p className={styles.desc}>{agent.description}</p>

            <div className={styles.meta}>
              <span className={styles.metaItem}>
                slug: <code>{agent.slug}</code>
              </span>
              {agent.last_heartbeat !== undefined && (
                <span className={styles.metaItem}>
                  heartbeat: {relativeTime(agent.last_heartbeat ?? null)}
                </span>
              )}
              {agent.tasks_completed !== undefined && (
                <span className={styles.metaItem}>
                  tasks done: {agent.tasks_completed}
                </span>
              )}
            </div>

            {expanded === agent.slug && (
              <div className={styles.drawer}>
                <p className={styles.drawerHeading}>Recent agent memory</p>
                <AgentMemoryDrawer slug={agent.slug} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
