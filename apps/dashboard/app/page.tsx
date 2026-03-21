'use client';

import { useEffect, useRef, useState } from 'react';
import AgentSidebar from '@/components/AgentSidebar';
import TaskBoard from '@/components/TaskBoard';
import MemoryFeed from '@/components/MemoryFeed';
import { WS_URL } from '@/lib/api';
import type { WsMessage } from '@/lib/types';
import styles from './page.module.css';

export default function Home() {
  const [connected, setConnected] = useState(false);
  const [liveTaskIds, setLiveTaskIds] = useState<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        // Reconnect after 3s
        setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();

      ws.onmessage = (msg) => {
        try {
          const payload = JSON.parse(msg.data as string) as WsMessage;
          if (payload.event === 'task_update' || payload.event === 'task_created') {
            const data = payload.data as { id: string };
            setLiveTaskIds((prev) => new Set([...prev, data.id]));
            setTimeout(() => {
              setLiveTaskIds((prev) => {
                const next = new Set(prev);
                next.delete(data.id);
                return next;
              });
            }, 4000);
          }
        } catch {
          // ignore
        }
      };
    }

    connect();
    return () => wsRef.current?.close();
  }, []);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>◈</span>
          TrustCore Mission Control
        </div>
        <div className={styles.status}>
          <span
            className={styles.wsIndicator}
            style={{ background: connected ? '#22c55e' : '#ef4444' }}
          />
          {connected ? 'Live' : 'Reconnecting…'}
        </div>
      </header>

      <div className={styles.body}>
        <AgentSidebar />
        <TaskBoard liveTaskIds={liveTaskIds} />
        <MemoryFeed />
      </div>
    </div>
  );
}
