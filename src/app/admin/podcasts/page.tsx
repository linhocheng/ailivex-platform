'use client';

/**
 * Admin — Podcast 素材總表：跨所有用戶的腳本與音檔，可聽、可下載、可看腳本、可刪
 */
import { useEffect, useState } from 'react';
import { Icon, EmptyState } from '@/app/_components/ui';
import type { PodcastLine } from '@/app/_components/PodcastLibrary';

interface AdminPodcast {
  id: string;
  owner: string;
  topic: string;
  speakers: string[];
  wordCount: number;
  script: PodcastLine[];
  audioUrl: string | null;
  status: string;
  createdAt: number;
}

const POD_ACCENT = '#6b8ec4';
const POD_BG     = 'rgba(107,142,196,0.10)';
const POD_BORDER = 'rgba(107,142,196,0.35)';

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  done:     { label: '已有音檔', color: 'var(--accent-2)' },
  scripted: { label: '僅腳本',   color: '#c2954e' },
  running:  { label: '生成中',   color: 'var(--muted)' },
  failed:   { label: '失敗',     color: '#b5654a' },
};

export default function AdminPodcasts() {
  const [items, setItems] = useState<AdminPodcast[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function load() {
    const r = await fetch('/api/admin/podcasts').then(r => r.json()).catch(() => null);
    if (r?.podcasts) setItems(r.podcasts);
    setLoaded(true);
  }

  useEffect(() => { load(); }, []);

  async function deleteItem(id: string) {
    if (!confirm('確定刪除這份 Podcast（含音檔）？')) return;
    setDeleting(id); setError('');
    const r = await fetch(`/api/admin/podcasts/${id}`, { method: 'DELETE' }).then(r => r.json()).catch(() => null);
    setDeleting(null);
    if (r?.ok) setItems(prev => prev.filter(it => it.id !== id));
    else setError('刪除失敗，請重試。');
  }

  return (
    <div style={{ padding: '30px 34px', overflowY: 'auto', height: '100%' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, margin: 0, fontWeight: 600, letterSpacing: '-0.02em' }}>Podcast 素材</h1>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '6px 0 0' }}>
          所有用戶生成的 Podcast 腳本與音檔（素材綁生成它的帳號，這裡是跨帳號總表）
        </p>
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: '#b5654a', padding: '9px 12px', borderRadius: 7, marginBottom: 14,
          background: 'rgba(181,101,74,0.08)', border: '1px solid rgba(181,101,74,0.2)' }}>
          {error}
        </div>
      )}

      {!loaded ? null : items.length === 0 ? (
        <EmptyState icon="audio" title="還沒有任何 Podcast 素材" desc="用戶在素材轉換區生成的 Podcast 會出現在這裡。" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 940 }}>
          {items.map(item => {
            const st = STATUS_LABEL[item.status] ?? { label: item.status, color: 'var(--muted)' };
            const isOpen = expanded === item.id;
            return (
              <div key={item.id} style={{ borderRadius: 10, border: '1px solid var(--border)',
                background: 'var(--panel)', overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
                    background: POD_BG, border: `1px solid ${POD_BORDER}`, color: POD_ACCENT }}>
                    <Icon name="audio" size={15} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.topic || '（無標題）'}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text)' }}>{item.owner}</span>
                      <span>{item.speakers.join(' × ') || '—'}</span>
                      <span>{item.wordCount} 字</span>
                      <span>{item.createdAt ? new Date(item.createdAt).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                      <span style={{ color: st.color }}>{st.label}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                    {item.script.length > 0 && (
                      <button onClick={() => setExpanded(isOpen ? null : item.id)}
                        style={{ padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer',
                          background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
                        {isOpen ? '收合腳本' : '看腳本'}
                      </button>
                    )}
                    <button onClick={() => deleteItem(item.id)} disabled={deleting === item.id}
                      style={{ padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer',
                        background: 'rgba(181,101,74,0.06)', border: '1px solid rgba(181,101,74,0.2)',
                        color: '#b5654a', opacity: deleting === item.id ? 0.5 : 1 }}>
                      {deleting === item.id ? '刪除中…' : '刪除'}
                    </button>
                  </div>
                </div>

                {item.audioUrl && (
                  <div style={{ padding: '0 16px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <audio controls src={item.audioUrl}
                      style={{ flex: 1, height: 36, borderRadius: 6, accentColor: POD_ACCENT }} />
                    <a href={item.audioUrl} target="_blank" rel="noopener noreferrer"
                      style={{ padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                        textDecoration: 'none', flexShrink: 0,
                        background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
                      下載
                    </a>
                  </div>
                )}

                {isOpen && (
                  <div style={{ padding: '0 16px 16px' }}>
                    <div style={{ fontSize: 12.5, lineHeight: 2, background: 'rgba(60,52,40,0.04)',
                      border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px',
                      maxHeight: 360, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                      {item.script.map((l, i) => `[${l.speaker}]: ${l.text}`).join('\n\n')}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
