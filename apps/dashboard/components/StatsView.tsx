'use client';

import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import styles from './StatsView.module.css';

interface AgentStat {
  slug: string;
  display_name: string;
  is_active: boolean;
  total: string;
  completed: string;
  failed: string;
  last_24h_completed: string;
  last_24h_failed: string;
}

interface TaskCount {
  status: string;
  count: string;
}

interface MemoryStat {
  event_type: string;
  total: string;
  last_24h: string;
}

interface SystemInfo {
  last_heartbeat: string | null;
  avg_duration_s: string | null;
}

interface Stats {
  agents: AgentStat[];
  tasks: TaskCount[];
  memory: MemoryStat[];
  system: SystemInfo;
}

function successRate(completed: string, failed: string): number {
  const c = parseInt(completed, 10);
  const f = parseInt(failed, 10);
  if (c + f === 0) return 100;
  return Math.round((c / (c + f)) * 100);
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 120) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

const STATUS_COLORS: Record<string, string> = {
  completed: '#22c55e',
  failed: '#ef4444',
  in_progress: '#3b82f6',
  pending: '#f59e0b',
  cancelled: '#64748b',
};

const TYPE_LABELS: Record<string, string> = {
  heartbeat: 'Heartbeat',
  task_started: 'Task Started',
  task_completed: 'Task Completed',
  task_failed: 'Task Failed',
  observation: 'Observation',
  consolidation_summary: 'Consolidation',
  system_alert: 'Alert',
  startup: 'Startup',
};

export default function StatsView() {
  const { data, isLoading } = useSWR<Stats>('/api/stats', fetcher, {
    refreshInterval: 10_000,
  });

  if (isLoading || !data) {
    return <div className={styles.loading}>Loading stats…</div>;
  }

  const totalTasks = data.tasks.reduce((s, t) => s + parseInt(t.count, 10), 0);
  const completedCount = parseInt(data.tasks.find((t) => t.status === 'completed')?.count ?? '0', 10);
  const failedCount = parseInt(data.tasks.find((t) => t.status === 'failed')?.count ?? '0', 10);
  const avgDuration = data.system.avg_duration_s
    ? Math.round(parseFloat(data.system.avg_duration_s))
    : null;

  return (
    <div className={styles.container}>
      <h2 className={styles.heading}>System Stats</h2>

      {/* System health row */}
      <div className={styles.healthRow}>
        <div className={styles.healthCard}>
          <span className={styles.healthLabel}>Last Heartbeat</span>
          <span className={styles.healthValue}>{relativeTime(data.system.last_heartbeat ?? null)}</span>
        </div>
        <div className={styles.healthCard}>
          <span className={styles.healthLabel}>Total Tasks</span>
          <span className={styles.healthValue}>{totalTasks}</span>
        </div>
        <div className={styles.healthCard}>
          <span className={styles.healthLabel}>Success Rate</span>
          <span className={styles.healthValue} style={{ color: successRate(String(completedCount), String(failedCount)) >= 90 ? '#22c55e' : '#f59e0b' }}>
            {successRate(String(completedCount), String(failedCount))}%
          </span>
        </div>
        <div className={styles.healthCard}>
          <span className={styles.healthLabel}>Avg Duration</span>
          <span className={styles.healthValue}>{avgDuration !== null ? `${avgDuration}s` : '—'}</span>
        </div>
      </div>

      <div className={styles.grid}>
        {/* Agent performance cards */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Agent Performance</h3>
          <div className={styles.agentCards}>
            {data.agents.map((agent) => {
              const rate = successRate(agent.completed, agent.failed);
              const total = parseInt(agent.total, 10);
              const done24h = parseInt(agent.last_24h_completed, 10);
              return (
                <div key={agent.slug} className={styles.agentCard}>
                  <div className={styles.agentHeader}>
                    <span className={styles.agentName}>{agent.display_name}</span>
                    <span className={`${styles.agentStatus} ${agent.is_active ? styles.active : styles.inactive}`}>
                      {agent.is_active ? 'active' : 'idle'}
                    </span>
                  </div>
                  <div className={styles.agentStats}>
                    <div className={styles.statItem}>
                      <span className={styles.statVal}>{total}</span>
                      <span className={styles.statLbl}>total</span>
                    </div>
                    <div className={styles.statItem}>
                      <span className={styles.statVal} style={{ color: '#22c55e' }}>{agent.completed}</span>
                      <span className={styles.statLbl}>done</span>
                    </div>
                    <div className={styles.statItem}>
                      <span className={styles.statVal} style={{ color: '#ef4444' }}>{agent.failed}</span>
                      <span className={styles.statLbl}>failed</span>
                    </div>
                    <div className={styles.statItem}>
                      <span className={styles.statVal} style={{ color: '#818cf8' }}>{done24h}</span>
                      <span className={styles.statLbl}>24h</span>
                    </div>
                  </div>
                  <div className={styles.rateBar}>
                    <div className={styles.rateBarFill} style={{ width: `${rate}%`, background: rate >= 90 ? '#22c55e' : rate >= 70 ? '#f59e0b' : '#ef4444' }} />
                  </div>
                  <span className={styles.rateLabel}>{rate}% success</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Task distribution */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Task Distribution</h3>
          <div className={styles.taskBars}>
            {data.tasks.map((t) => {
              const pct = totalTasks > 0 ? Math.round((parseInt(t.count, 10) / totalTasks) * 100) : 0;
              return (
                <div key={t.status} className={styles.taskBarRow}>
                  <span className={styles.taskBarLabel}>{t.status}</span>
                  <div className={styles.taskBarTrack}>
                    <div
                      className={styles.taskBarFill}
                      style={{ width: `${pct}%`, background: STATUS_COLORS[t.status] ?? '#64748b' }}
                    />
                  </div>
                  <span className={styles.taskBarCount}>{t.count}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Memory activity */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Memory Activity</h3>
          <div className={styles.memoryTable}>
            <div className={styles.memHeaderRow}>
              <span>Type</span>
              <span>24h</span>
              <span>Total</span>
            </div>
            {data.memory.map((m) => (
              <div key={m.event_type} className={styles.memRow}>
                <span className={styles.memType}>{TYPE_LABELS[m.event_type] ?? m.event_type}</span>
                <span className={styles.memCount24}>{m.last_24h}</span>
                <span className={styles.memCountTotal}>{m.total}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
