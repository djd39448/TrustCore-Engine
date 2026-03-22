'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import styles from './DocsView.module.css';

interface KbSource {
  source: string;
  chunks: string;
  ingested_at: string;
}

interface KbChunk {
  id: string;
  title: string;
  source: string;
  chunk_index: number;
  content: string;
  created_at: string;
}

function relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function shortSource(source: string): string {
  // e.g. "factory/trustcore-agent-v1" → "trustcore-agent-v1"
  return source.split('/').pop() ?? source;
}

export default function DocsView() {
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const { data: sources, isLoading: loadingSources } = useSWR<KbSource[]>(
    '/api/knowledge/sources',
    fetcher,
    { refreshInterval: 30_000 }
  );

  const { data: chunks, isLoading: loadingChunks } = useSWR<KbChunk[]>(
    selectedSource
      ? `/api/knowledge?source=${encodeURIComponent(selectedSource)}&limit=200`
      : null,
    fetcher
  );

  const filtered = (chunks ?? []).filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.title.toLowerCase().includes(q) || c.content.toLowerCase().includes(q);
  });

  return (
    <div className={styles.container}>
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarTitle}>Knowledge Base</span>
          <span className={styles.sidebarCount}>{sources?.length ?? 0} sources</span>
        </div>

        {loadingSources && <p className={styles.loading}>Loading…</p>}

        {!loadingSources && (!sources || sources.length === 0) && (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No documents ingested</p>
            <p className={styles.emptyHint}>Run <code>npm run ingest &lt;file&gt;</code> to add documents.</p>
          </div>
        )}

        {(sources ?? []).map((s) => (
          <button
            key={s.source}
            className={`${styles.sourceBtn} ${selectedSource === s.source ? styles.sourceActive : ''}`}
            onClick={() => { setSelectedSource(s.source); setSearch(''); }}
          >
            <span className={styles.sourceName}>{shortSource(s.source)}</span>
            <span className={styles.sourceMeta}>{s.chunks} chunk{s.chunks === '1' ? '' : 's'} · {relTime(s.ingested_at)}</span>
          </button>
        ))}
      </div>

      <div className={styles.main}>
        {!selectedSource && (
          <div className={styles.welcome}>
            <p className={styles.welcomeTitle}>Knowledge Base Viewer</p>
            <p className={styles.welcomeHint}>Select a source from the left to browse its content.</p>
            <p className={styles.welcomeHint}>The research agent searches this database before web search.</p>
          </div>
        )}

        {selectedSource && (
          <>
            <div className={styles.mainHeader}>
              <span className={styles.mainTitle}>{selectedSource}</span>
              <input
                className={styles.searchInput}
                placeholder="Search chunks…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {loadingChunks && <p className={styles.loading}>Loading chunks…</p>}

            {!loadingChunks && filtered.length === 0 && (
              <p className={styles.loading}>{search ? 'No chunks match your search.' : 'No chunks found.'}</p>
            )}

            <div className={styles.chunks}>
              {filtered.map((chunk) => (
                <div key={chunk.id} className={styles.chunk}>
                  <div className={styles.chunkHeader}>
                    <span className={styles.chunkTitle}>{chunk.title}</span>
                    <span className={styles.chunkIndex}>chunk {chunk.chunk_index}</span>
                  </div>
                  <pre className={styles.chunkContent}>{chunk.content}</pre>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
