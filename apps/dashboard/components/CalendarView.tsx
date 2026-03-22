'use client';

import { useState } from 'react';
import useSWR, { mutate } from 'swr';
import { fetcher } from '@/lib/api';
import styles from './CalendarView.module.css';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3003';

interface HourlyBucket {
  hour: string;
  created: string;
  completed: string;
  failed: string;
}

interface RecentTask {
  id: string;
  title: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  started_at: string | null;
  assigned_to: string | null;
  agent_name: string | null;
}

interface ActivityData {
  hourly: HourlyBucket[];
  recent: RecentTask[];
}

const STATUS_COLOR: Record<string, string> = {
  completed: '#22c55e',
  failed: '#ef4444',
  in_progress: '#3b82f6',
  pending: '#f59e0b',
};

function relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatHour(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function ActivityChart({ hourly }: { hourly: HourlyBucket[] }) {
  if (hourly.length === 0) {
    return <p className={styles.empty}>No task activity yet.</p>;
  }

  const maxVal = Math.max(...hourly.map((h) => parseInt(h.created, 10)), 1);

  return (
    <div className={styles.chart}>
      <div className={styles.chartBars}>
        {hourly.map((h) => {
          const created = parseInt(h.created, 10);
          const completed = parseInt(h.completed, 10);
          const failed = parseInt(h.failed, 10);
          const pct = Math.round((created / maxVal) * 100);
          return (
            <div key={h.hour} className={styles.barCol} title={`${formatHour(h.hour)}: ${created} created, ${completed} done, ${failed} failed`}>
              <div className={styles.barStack} style={{ height: `${Math.max(pct, 2)}%` }}>
                {failed > 0 && (
                  <div className={styles.barSegment} style={{ flex: failed, background: '#ef4444' }} />
                )}
                {completed > 0 && (
                  <div className={styles.barSegment} style={{ flex: completed, background: '#22c55e' }} />
                )}
                {(created - completed - failed) > 0 && (
                  <div className={styles.barSegment} style={{ flex: created - completed - failed, background: '#6366f1' }} />
                )}
              </div>
              <span className={styles.barLabel}>{formatHour(h.hour)}</span>
            </div>
          );
        })}
      </div>
      <div className={styles.chartLegend}>
        <span style={{ color: '#22c55e' }}>■ completed</span>
        <span style={{ color: '#ef4444' }}>■ failed</span>
        <span style={{ color: '#6366f1' }}>■ pending/running</span>
      </div>
    </div>
  );
}

function IngestForm() {
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !source.trim() || !content.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API_BASE}/api/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), source: source.trim(), content: content.trim() }),
      });
      const data = await res.json() as { chunks?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setMsg({ ok: true, text: `Ingested ${data.chunks} chunk${data.chunks === 1 ? '' : 's'} into "${source}"` });
      setTitle(''); setSource(''); setContent('');
      await mutate('/api/knowledge/sources');
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.ingestPanel}>
      <h4 className={styles.ingestTitle}>Ingest Document</h4>
      <form onSubmit={submit} className={styles.ingestForm}>
        <input
          className={styles.ingestInput}
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <input
          className={styles.ingestInput}
          placeholder="Source (e.g. docs/readme)"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          required
        />
        <textarea
          className={styles.ingestTextarea}
          placeholder="Paste document content here…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={6}
          required
        />
        {msg && (
          <p className={msg.ok ? styles.msgOk : styles.msgErr}>{msg.text}</p>
        )}
        <button type="submit" className={styles.ingestBtn} disabled={busy}>
          {busy ? 'Ingesting…' : 'Ingest'}
        </button>
      </form>
    </div>
  );
}

export default function CalendarView() {
  const { data } = useSWR<ActivityData>('/api/activity?hours=24', fetcher, {
    refreshInterval: 10_000,
  });

  const hourly = data?.hourly ?? [];
  const recent = data?.recent ?? [];

  return (
    <div className={styles.container}>
      <div className={styles.left}>
        <h2 className={styles.heading}>Task Activity — Last 24h</h2>
        <ActivityChart hourly={hourly} />

        <h3 className={styles.subheading}>Recent Tasks</h3>
        <div className={styles.timeline}>
          {recent.length === 0 && <p className={styles.empty}>No tasks yet.</p>}
          {recent.map((t) => (
            <div key={t.id} className={styles.timelineItem}>
              <span
                className={styles.dot}
                style={{ background: STATUS_COLOR[t.status] ?? '#64748b' }}
              />
              <div className={styles.timelineBody}>
                <span className={styles.timelineTitle}>{t.title}</span>
                <span className={styles.timelineMeta}>
                  {t.agent_name ?? 'unassigned'} · {relTime(t.created_at)}
                  {t.completed_at && t.started_at && (
                    <> · {Math.round((new Date(t.completed_at).getTime() - new Date(t.started_at).getTime()) / 1000)}s</>
                  )}
                </span>
              </div>
              <span
                className={styles.statusBadge}
                style={{ color: STATUS_COLOR[t.status] ?? '#64748b' }}
              >
                {t.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.right}>
        <IngestForm />
      </div>
    </div>
  );
}
