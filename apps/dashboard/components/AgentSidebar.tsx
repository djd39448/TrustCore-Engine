'use client';

import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import type { Agent } from '@/lib/types';
import styles from './AgentSidebar.module.css';

const TYPE_BADGE: Record<string, string> = {
  chief: 'Chief',
  'sub-agent': 'Sub',
  system: 'Sys',
};

const TYPE_COLOR: Record<string, string> = {
  chief: '#6366f1',
  'sub-agent': '#10b981',
  system: '#64748b',
};

export default function AgentSidebar() {
  const { data: agents, error } = useSWR<Agent[]>('/api/agents', fetcher, {
    refreshInterval: 15_000,
  });

  return (
    <aside className={styles.sidebar}>
      <h2 className={styles.heading}>Agents</h2>

      {error && <p className={styles.error}>Failed to load agents</p>}
      {!agents && !error && <p className={styles.muted}>Loading…</p>}

      <ul className={styles.list}>
        {agents?.map((agent) => (
          <li key={agent.id} className={styles.item}>
            <div className={styles.nameRow}>
              <span
                className={styles.badge}
                style={{ background: TYPE_COLOR[agent.type] ?? '#64748b' }}
              >
                {TYPE_BADGE[agent.type] ?? agent.type}
              </span>
              <span className={styles.name}>{agent.display_name}</span>
              <span
                className={styles.dot}
                style={{ background: agent.is_active ? '#22c55e' : '#ef4444' }}
                title={agent.is_active ? 'Active' : 'Inactive'}
              />
            </div>
            <p className={styles.desc}>{agent.description}</p>
          </li>
        ))}
      </ul>
    </aside>
  );
}
