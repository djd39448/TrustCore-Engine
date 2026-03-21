'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { fetcher, WS_URL } from '@/lib/api';
import type { MemoryEvent, WsMessage } from '@/lib/types';
import styles from './MemoryFeed.module.css';

const EVENT_COLOR: Record<string, string> = {
  task_started: '#3b82f6',
  task_completed: '#22c55e',
  task_failed: '#ef4444',
  agent_called: '#a855f7',
  user_interaction: '#f59e0b',
  observation: '#64748b',
  consolidation_summary: '#0ea5e9',
};

const IMPORTANCE_LABEL = ['', 'Low', 'Low', 'Med', 'High', 'Critical'];

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function EventRow({ event, isNew }: { event: MemoryEvent; isNew: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const color = EVENT_COLOR[event.event_type] ?? '#64748b';

  return (
    <div
      className={`${styles.row} ${isNew ? styles.fresh : ''}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className={styles.rowHeader}>
        <span className={styles.dot} style={{ background: color }} />
        <span className={styles.type} style={{ color }}>
          {event.event_type}
        </span>
        <span className={styles.agent}>{event.agent_slug}</span>
        <span className={styles.time}>{relativeTime(event.created_at)}</span>
        <span className={styles.imp} title={`Importance ${event.importance}`}>
          {IMPORTANCE_LABEL[event.importance] ?? event.importance}
        </span>
      </div>
      <p className={styles.summary}>{event.summary}</p>
      {expanded && (
        <pre className={styles.content}>
          {JSON.stringify(event.content, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function MemoryFeed() {
  const { data: initial } = useSWR<MemoryEvent[]>(
    '/api/memories?limit=50',
    fetcher,
    { revalidateOnFocus: false }
  );

  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const seenRef = useRef<Set<string>>(new Set());

  // Seed from REST on first load
  useEffect(() => {
    if (initial && events.length === 0) {
      setEvents(initial);
      initial.forEach((e) => seenRef.current.add(e.id));
    }
  }, [initial, events.length]);

  // Live WebSocket updates
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (msg) => {
      try {
        const payload = JSON.parse(msg.data as string) as WsMessage;
        if (payload.event === 'memory_event') {
          const ev = payload.data as MemoryEvent;
          if (!seenRef.current.has(ev.id)) {
            seenRef.current.add(ev.id);
            setEvents((prev) => [ev, ...prev].slice(0, 200));
            setNewIds((prev) => new Set([...prev, ev.id]));
            setTimeout(() => {
              setNewIds((prev) => {
                const next = new Set(prev);
                next.delete(ev.id);
                return next;
              });
            }, 4000);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => console.warn('[MemoryFeed] WebSocket error');

    return () => ws.close();
  }, []);

  return (
    <div className={styles.feed}>
      <h2 className={styles.heading}>Memory Feed</h2>
      <div className={styles.list}>
        {events.length === 0 && (
          <p className={styles.empty}>Waiting for events…</p>
        )}
        {events.map((ev) => (
          <EventRow key={ev.id} event={ev} isNew={newIds.has(ev.id)} />
        ))}
      </div>
    </div>
  );
}
