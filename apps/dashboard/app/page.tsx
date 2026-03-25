'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import AgentSidebar from '@/components/AgentSidebar';
import TaskBoard from '@/components/TaskBoard';
import MemoryFeed from '@/components/MemoryFeed';
import MemoryView from '@/components/MemoryView';
import AgentsView from '@/components/AgentsView';
import OfficeView from '@/components/OfficeView';
import ChatPanel from '@/components/ChatPanel';
import { fetcher, WS_URL } from '@/lib/api';
import type { WsMessage } from '@/lib/types';
import styles from './page.module.css';

type Tab = 'tasks' | 'chat' | 'memories' | 'team' | 'calendar' | 'projects' | 'docs' | 'office';

const TABS: { id: Tab; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'chat', label: 'Chat' },
  { id: 'memories', label: 'Memories' },
  { id: 'team', label: 'Team' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'projects', label: 'Projects' },
  { id: 'docs', label: 'Docs' },
  { id: 'office', label: 'Office' },
];

interface HeartbeatData {
  last_heartbeat: string | null;
  agent: string | null;
}

function HeartbeatIndicator() {
  const { data } = useSWR<HeartbeatData>('/api/heartbeat', fetcher, { refreshInterval: 30_000 });

  if (!data || !data.last_heartbeat) {
    return (
      <div className={styles.heartbeat} title="No heartbeat recorded">
        <span className={styles.hbDot} style={{ background: '#ef4444' }} />
        <span className={styles.hbLabel}>No heartbeat</span>
      </div>
    );
  }

  const ageMins = (Date.now() - new Date(data.last_heartbeat).getTime()) / 60_000;
  const color = ageMins < 2 ? '#22c55e' : ageMins < 5 ? '#f59e0b' : '#ef4444';
  const label = ageMins < 2
    ? `Alex: ${Math.round(ageMins * 60)}s ago`
    : ageMins < 5
    ? `Alex: ${Math.round(ageMins)}m ago`
    : `Alex: ${Math.round(ageMins)}m ago ⚠`;

  return (
    <div className={styles.heartbeat} title={`Last heartbeat: ${data.last_heartbeat}`}>
      <span className={styles.hbDot} style={{ background: color }} />
      <span className={styles.hbLabel} style={{ color }}>{label}</span>
    </div>
  );
}

function PlaceholderView({ name }: { name: string }) {
  return (
    <div className={styles.placeholder}>
      <p className={styles.placeholderText}>{name} — coming soon</p>
    </div>
  );
}

export default function Home() {
  const [connected, setConnected] = useState(false);
  const [liveTaskIds, setLiveTaskIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<Tab>('tasks');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
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

  function renderMain() {
    switch (activeTab) {
      case 'tasks': return <TaskBoard liveTaskIds={liveTaskIds} />;
      case 'chat': return <ChatPanel />;
      case 'memories': return <MemoryView />;
      case 'team': return <AgentsView />;
      case 'calendar': return <PlaceholderView name="Calendar" />;
      case 'projects': return <PlaceholderView name="Projects" />;
      case 'docs': return <PlaceholderView name="Docs" />;
      case 'office': return <OfficeView />;
    }
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>◈</span>
          TrustCore Mission Control
        </div>
        <nav className={styles.tabs}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className={styles.headerRight}>
          <HeartbeatIndicator />
          <div className={styles.status}>
            <span
              className={styles.wsIndicator}
              style={{ background: connected ? '#22c55e' : '#ef4444' }}
            />
            {connected ? 'Live' : 'Reconnecting…'}
          </div>
        </div>
      </header>

      <div className={styles.body}>
        <AgentSidebar />
        {renderMain()}
        {activeTab === 'tasks' && <MemoryFeed />}
      </div>
    </div>
  );
}
