'use client';

import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import styles from './OfficeView.module.css';

interface GPUStatus {
  index: number;
  name: string;
  memoryUsedMb: number;
  memoryFreeMb: number;
  memoryTotalMb: number;
  utilizationPct: number;
  temperatureC: number | null;
}

interface QueueStatus {
  depth: number;
  active: number;
  maxConcurrent: number;
  pending: { id: string; label: string; priority: number; modelName: string; waitMs: number }[];
}

interface GPUMetricRow {
  gpu_index: number;
  utilization_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  recorded_at: string;
}

function utilColor(pct: number): string {
  if (pct >= 80) return '#ef4444';
  if (pct >= 60) return '#f59e0b';
  return '#22c55e';
}

function tempColor(c: number | null): string {
  if (c === null) return '#64748b';
  if (c >= 85) return '#ef4444';
  if (c >= 70) return '#f59e0b';
  return '#22c55e';
}

function GPUCard({ gpu }: { gpu: GPUStatus }) {
  const memPct = Math.round((gpu.memoryUsedMb / gpu.memoryTotalMb) * 100);
  const uColor = utilColor(gpu.utilizationPct);
  const isFactory = gpu.index === 0 && gpu.utilizationPct > 50;

  return (
    <div className={styles.gpuCard}>
      <div className={styles.gpuHeader}>
        <span className={styles.gpuLabel}>GPU {gpu.index}</span>
        {isFactory && <span className={styles.factoryBadge}>Factory running</span>}
        <span className={styles.gpuName}>{gpu.name}</span>
      </div>

      <div className={styles.statRow}>
        <span className={styles.statLabel}>Utilization</span>
        <span className={styles.statValue} style={{ color: uColor }}>{gpu.utilizationPct}%</span>
      </div>
      <div className={styles.progressTrack}>
        <div
          className={styles.progressFill}
          style={{ width: `${gpu.utilizationPct}%`, background: uColor }}
        />
      </div>

      <div className={styles.statRow}>
        <span className={styles.statLabel}>VRAM</span>
        <span className={styles.statValue}>
          {gpu.memoryUsedMb.toLocaleString()} / {gpu.memoryTotalMb.toLocaleString()} MiB
          <span className={styles.pct}> ({memPct}%)</span>
        </span>
      </div>
      <div className={styles.progressTrack}>
        <div
          className={styles.progressFill}
          style={{ width: `${memPct}%`, background: utilColor(memPct) }}
        />
      </div>

      {gpu.temperatureC !== null && (
        <div className={styles.statRow}>
          <span className={styles.statLabel}>Temperature</span>
          <span className={styles.statValue} style={{ color: tempColor(gpu.temperatureC) }}>
            {gpu.temperatureC}°C
          </span>
        </div>
      )}
    </div>
  );
}

const PRIORITY_LABEL: Record<number, string> = {
  1: 'alex_routing',
  2: 'agent_exec',
  3: 'embeddings',
  4: 'factory',
};

function QueuePanel({ queue }: { queue: QueueStatus }) {
  return (
    <div className={styles.queuePanel}>
      <div className={styles.sectionHeading}>LLM Queue</div>
      <div className={styles.queueStats}>
        <div className={styles.queueStat}>
          <span className={styles.queueStatNum}>{queue.active}</span>
          <span className={styles.queueStatLabel}>active / {queue.maxConcurrent}</span>
        </div>
        <div className={styles.queueStat}>
          <span className={styles.queueStatNum}>{queue.depth}</span>
          <span className={styles.queueStatLabel}>queued</span>
        </div>
      </div>
      {queue.pending.length > 0 && (
        <ul className={styles.queueList}>
          {queue.pending.map((r) => (
            <li key={r.id} className={styles.queueItem}>
              <span className={styles.queuePriority}>P{r.priority} {PRIORITY_LABEL[r.priority]}</span>
              <span className={styles.queueItemLabel}>{r.label}</span>
              <span className={styles.queueWait}>{Math.round(r.waitMs / 1000)}s</span>
            </li>
          ))}
        </ul>
      )}
      {queue.pending.length === 0 && (
        <p className={styles.queueEmpty}>Queue empty — all slots free</p>
      )}
    </div>
  );
}

/** Simple SVG sparkline of utilization over time for one GPU. */
function HistoryChart({ rows, gpuIndex }: { rows: GPUMetricRow[]; gpuIndex: number }) {
  const data = rows.filter((r) => r.gpu_index === gpuIndex);
  if (data.length < 2) return <p className={styles.chartEmpty}>No history yet</p>;

  const W = 400;
  const H = 60;
  const pad = 4;

  const xs = data.map((_, i) => pad + (i / (data.length - 1)) * (W - 2 * pad));
  const ys = data.map((r) => H - pad - (r.utilization_percent / 100) * (H - 2 * pad));

  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(' ');
  const fill = `${path} L${xs[xs.length - 1]!.toFixed(1)},${H - pad} L${pad},${H - pad} Z`;

  const last = data[data.length - 1]!;
  const lineColor = utilColor(last.utilization_percent);

  return (
    <div className={styles.chartWrap}>
      <div className={styles.chartLabel}>
        GPU {gpuIndex} utilization (last {data.length} samples)
        <span style={{ color: lineColor, marginLeft: '0.5rem' }}>{last.utilization_percent}%</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className={styles.chart}>
        {/* Grid lines at 25%, 50%, 75% */}
        {[25, 50, 75].map((pct) => {
          const y = H - pad - (pct / 100) * (H - 2 * pad);
          return (
            <line key={pct} x1={pad} y1={y} x2={W - pad} y2={y}
              stroke="#1e293b" strokeWidth="1" />
          );
        })}
        <path d={fill} fill={lineColor} fillOpacity="0.12" />
        <path d={path} fill="none" stroke={lineColor} strokeWidth="1.5" />
      </svg>
    </div>
  );
}

export default function OfficeView() {
  const { data: gpus } = useSWR<GPUStatus[]>('/api/gpu', fetcher, { refreshInterval: 10_000 });
  const { data: queue } = useSWR<QueueStatus>('/api/queue', fetcher, { refreshInterval: 5_000 });
  const { data: history } = useSWR<GPUMetricRow[]>('/api/gpu/history?minutes=60', fetcher, { refreshInterval: 30_000 });

  const gpuList = gpus ?? [];
  const queueData = queue ?? { depth: 0, active: 0, maxConcurrent: 2, pending: [] };
  const historyRows = history ?? [];

  return (
    <div className={styles.view}>
      <div className={styles.sectionHeading} style={{ padding: '0 1.25rem', paddingTop: '1.25rem' }}>
        GPU Resource Manager
      </div>

      {/* GPU cards */}
      <div className={styles.gpuRow}>
        {gpuList.length === 0 && (
          <p className={styles.muted}>Loading GPU data…</p>
        )}
        {gpuList.map((gpu) => <GPUCard key={gpu.index} gpu={gpu} />)}
      </div>

      {/* Queue panel */}
      <QueuePanel queue={queueData} />

      {/* History charts */}
      {historyRows.length > 0 && (
        <div className={styles.chartsSection}>
          <div className={styles.sectionHeading}>Utilization History (60 min)</div>
          {[0, 1].map((idx) => (
            <HistoryChart key={idx} rows={historyRows} gpuIndex={idx} />
          ))}
        </div>
      )}
    </div>
  );
}
