'use client';

/**
 * Podcast 腳本庫 — 共用元件（唯一真相源）
 * 用在 /convert（生成流程下方）與 /podcasts（素材收集頁）。
 * 資料來源：GET /api/convert/podcast/scripts（當前用戶的 scripted/done tasks）
 */
import { useEffect, useState } from 'react';
import { Icon, Typing, EmptyState } from '@/app/_components/ui';

export interface PodcastLine { speaker: string; characterId: string; text: string; }

export interface ScriptItem {
  id: string;
  topic: string;
  focus: string;
  characterIds: string[];
  speakers: string[];
  wordCount: number;
  script: PodcastLine[];
  audioUrl: string | null;
  status: string;
  error?: string | null;
  createdAt: number;
}

const POD_ACCENT = '#6b8ec4';
const POD_BG     = 'rgba(107,142,196,0.10)';
const POD_BORDER = 'rgba(107,142,196,0.35)';

export function scriptToText(lines: PodcastLine[]): string {
  return lines.map(l => `[${l.speaker}]: ${l.text}`).join('\n\n');
}

export function PodcastLibrary({ chars, refreshSignal, showEmpty = false }: {
  chars: Array<{ id: string; name: string }>;
  refreshSignal: number;
  showEmpty?: boolean;
}) {
  const [items, setItems]           = useState<ScriptItem[]>([]);
  const [loaded, setLoaded]         = useState(false);
  const [editing, setEditing]       = useState<string | null>(null);
  const [editText, setEditText]     = useState('');
  const [saving, setSaving]         = useState(false);
  const [deleting, setDeleting]     = useState<string | null>(null);
  const [retrying, setRetrying]     = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState<string | null>(null);
  const [audioUrls, setAudioUrls]   = useState<Record<string, string>>({});
  const [error, setError]           = useState('');

  const nameToId = Object.fromEntries(chars.map(c => [c.name, c.id]));

  async function load() {
    const r = await fetch('/api/convert/podcast/scripts').then(r => r.json()).catch(() => null);
    if (r?.scripts) { setItems(r.scripts); setLoaded(true); }
  }

  useEffect(() => { load(); }, [refreshSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // 有生成中的任務 → 每 10 秒自動刷新，直到它完成或失敗
  const hasRunning = items.some(it => it.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [hasRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  function startEdit(item: ScriptItem) {
    setEditing(item.id);
    setEditText(scriptToText(item.script));
    setError('');
  }

  function parseLines(text: string): PodcastLine[] {
    return text.split('\n')
      .map(l => l.match(/^\[([^\]]+)\][:：]\s*(.+)/))
      .filter(Boolean)
      .map(m => ({ speaker: m![1].trim(), characterId: nameToId[m![1].trim()] ?? '', text: m![2].trim() }));
  }

  async function saveEdit(id: string) {
    setSaving(true); setError('');
    const newScript = parseLines(editText);
    const r = await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ podcastScript: newScript }),
    }).then(r => r.json()).catch(() => null);
    setSaving(false);
    if (r?.ok) {
      setItems(prev => prev.map(it => it.id === id
        ? { ...it, script: newScript, wordCount: newScript.reduce((s,l) => s+l.text.length, 0),
            speakers: [...new Set(newScript.map(l => l.speaker))] }
        : it));
      setEditing(null);
    } else {
      setError('儲存失敗，請重試。');
    }
  }

  async function deleteItem(id: string) {
    setDeleting(id);
    const r = await fetch(`/api/tasks/${id}`, { method: 'DELETE' }).then(r => r.json()).catch(() => null);
    setDeleting(null);
    if (r?.ok) setItems(prev => prev.filter(it => it.id !== id));
    else setError('刪除失敗，請重試。');
  }

  async function retryItem(id: string) {
    setRetrying(id); setError('');
    const r = await fetch('/api/convert/podcast/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: id }),
    }).then(r => r.json()).catch(() => null);
    setRetrying(null);
    if (r?.accepted) {
      // 卡片轉回「生成中」，hasRunning 自動輪詢接手到完成
      setItems(prev => prev.map(it => it.id === id ? { ...it, status: 'running', error: null } : it));
    } else {
      setError(r?.error ?? '重啟失敗，請重試。');
    }
  }

  async function generateAudio(item: ScriptItem) {
    setAudioLoading(item.id); setError('');
    const r = await fetch('/api/convert/podcast/generate-audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: item.id, script: item.script }),
    }).then(r => r.json()).catch(() => null);
    setAudioLoading(null);
    if (r?.accepted) {
      // worker 背景跑，卡片轉「音檔生成中」，hasRunning 自動輪詢會接手到完成
      setItems(prev => prev.map(it => it.id === item.id ? { ...it, status: 'running' } : it));
    } else {
      setError(r?.error ?? '音檔生成失敗，請重試。');
    }
  }

  if (!loaded) return null;
  if (items.length === 0) {
    return showEmpty
      ? <EmptyState icon="audio" title="還沒有 Podcast 素材"
          desc="到素材轉換區生成第一集 Podcast 腳本，完成後會收集在這裡。" />
      : null;
  }

  return (
    <div style={{ marginTop: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 14 }}>
        Podcast 腳本庫
        <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 400, color: 'var(--muted)' }}>
          {items.length} 份腳本
        </span>
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: '#b5654a', padding: '9px 12px', borderRadius: 7, marginBottom: 12,
          background: 'rgba(181,101,74,0.08)', border: '1px solid rgba(181,101,74,0.2)' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map(item => {
          const isEditing = editing === item.id;
          const isDeleting = deleting === item.id;
          const isGenAudio = audioLoading === item.id;
          const liveAudioUrl = audioUrls[item.id] ?? item.audioUrl;

          // 生成中／失敗的任務也要看得見——不然背景有任務前端卻隱形
          if (item.status === 'running' && item.script.length === 0) {
            return (
              <div key={item.id} className="ax-enter" style={{ borderRadius: 10, border: `1px dashed ${POD_BORDER}`,
                background: POD_BG, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <Typing />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: POD_ACCENT }}>腳本生成中…</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                    {item.topic || '（無標題）'} · {new Date(item.createdAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })} 開始 · 完成後自動出現在這裡
                  </div>
                </div>
                <button onClick={() => deleteItem(item.id)} disabled={isDeleting}
                  title="取消並刪除這個任務（背景生成若已在跑會作廢）"
                  style={{ padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', flexShrink: 0,
                    background: 'rgba(181,101,74,0.06)', border: '1px solid rgba(181,101,74,0.2)',
                    color: '#b5654a', opacity: isDeleting ? 0.5 : 1 }}>
                  {isDeleting ? '刪除中…' : '刪除'}
                </button>
              </div>
            );
          }
          if (item.status === 'failed' && item.script.length === 0) {
            const isRetrying = retrying === item.id;
            return (
              <div key={item.id} className="ax-enter" style={{ borderRadius: 10, border: '1px solid rgba(181,101,74,0.25)',
                background: 'rgba(181,101,74,0.05)', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#b5654a' }}>生成失敗</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.topic || '（無標題）'}{item.error ? ` · ${item.error}` : ''}
                  </div>
                </div>
                <button onClick={() => retryItem(item.id)} disabled={isRetrying || isDeleting}
                  style={{ padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', flexShrink: 0,
                    background: POD_BG, border: `1px solid ${POD_BORDER}`,
                    color: POD_ACCENT, opacity: isRetrying ? 0.5 : 1 }}>
                  {isRetrying ? '重啟中…' : '重啟'}
                </button>
                <button onClick={() => deleteItem(item.id)} disabled={isDeleting || isRetrying}
                  style={{ padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', flexShrink: 0,
                    background: 'rgba(181,101,74,0.06)', border: '1px solid rgba(181,101,74,0.2)',
                    color: '#b5654a', opacity: isDeleting ? 0.5 : 1 }}>
                  {isDeleting ? '刪除中…' : '清除'}
                </button>
              </div>
            );
          }

          return (
            <div key={item.id} className="ax-enter" style={{ borderRadius: 10, border: '1px solid var(--border)',
              background: 'var(--panel)', overflow: 'hidden' }}>

              {/* 卡片頭 */}
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
                    <span>{item.speakers.join(' × ')}</span>
                    <span>{item.wordCount} 字</span>
                    <span>{new Date(item.createdAt).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    {item.status === 'done' && <span style={{ color: 'var(--accent-2)' }}>已有音檔</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                  {!isEditing && (
                    <button onClick={() => startEdit(item)}
                      style={{ padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer',
                        background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
                      編輯
                    </button>
                  )}
                  <button onClick={() => deleteItem(item.id)} disabled={isDeleting}
                    style={{ padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer',
                      background: 'rgba(181,101,74,0.06)', border: '1px solid rgba(181,101,74,0.2)',
                      color: '#b5654a', opacity: isDeleting ? 0.5 : 1 }}>
                    {isDeleting ? '刪除中…' : '刪除'}
                  </button>
                </div>
              </div>

              {/* 音檔播放或生成按鈕 */}
              {!isEditing && (
                <div style={{ padding: '0 16px 14px' }}>
                  {item.status === 'running' && !liveAudioUrl ? (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
                      padding: '7px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 500,
                      background: POD_BG, border: `1px solid ${POD_BORDER}`, color: POD_ACCENT }}>
                      <Typing />音檔生成中…（長腳本可能需要 10 分鐘以上，完成後自動出現）
                    </div>
                  ) : liveAudioUrl ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <audio controls src={liveAudioUrl}
                        style={{ flex: 1, height: 36, borderRadius: 6, accentColor: POD_ACCENT }} />
                      <a href={liveAudioUrl} target="_blank" rel="noopener noreferrer"
                        style={{ padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                          textDecoration: 'none', flexShrink: 0,
                          background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
                        下載
                      </a>
                    </div>
                  ) : (
                    <button onClick={() => generateAudio(item)} disabled={!!isGenAudio}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 7,
                        padding: '7px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
                        background: isGenAudio ? 'rgba(60,52,40,0.04)' : POD_BG,
                        border: `1px solid ${isGenAudio ? 'var(--border)' : POD_BORDER}`,
                        color: isGenAudio ? 'var(--muted)' : POD_ACCENT }}>
                      {isGenAudio ? <><Typing />生成音檔中…</> : <><Icon name="audio" size={13} />生成音檔</>}
                    </button>
                  )}
                </div>
              )}

              {/* 腳本編輯區 */}
              {isEditing && (
                <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>對話腳本（可直接編輯）</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                      {editText.replace(/\[[^\]]+\][:：]\s*/g, '').replace(/\s+/g, '').length} 字
                    </div>
                  </div>
                  <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={12}
                    style={{ width: '100%', resize: 'vertical', fontSize: 12.5, lineHeight: 1.9,
                      background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', borderRadius: 8,
                      padding: '10px 12px', color: 'var(--text)', fontFamily: 'monospace', boxSizing: 'border-box' }} />
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setEditing(null)} disabled={saving}
                      style={{ padding: '7px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 500,
                        cursor: 'pointer', background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)',
                        color: 'var(--muted)' }}>
                      取消
                    </button>
                    <button onClick={() => saveEdit(item.id)} disabled={saving}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '7px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                        background: saving ? 'rgba(60,52,40,0.04)' : POD_BG,
                        border: `1px solid ${saving ? 'var(--border)' : POD_BORDER}`,
                        color: saving ? 'var(--muted)' : POD_ACCENT }}>
                      {saving ? <><Typing />儲存中…</> : '儲存腳本'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
