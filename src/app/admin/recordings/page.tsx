'use client';

import { useEffect, useState, useCallback } from 'react';

interface RecordingRow {
  roomName: string; characterId: string; characterName: string; userId: string;
  status: 'recording' | 'done' | 'failed';
  durationSec: number | null; sizeBytes: number | null;
  createdAt: string; url: string;
}

const STATUS_LABEL: Record<RecordingRow['status'], { text: string; color: string }> = {
  recording: { text: '錄音中', color: 'var(--accent)' },
  done:      { text: '完成',   color: 'var(--text)' },
  failed:    { text: '失敗',   color: '#c0392b' },
};

function fmtDuration(sec: number | null): string {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function fmtSize(bytes: number | null): string {
  if (!bytes) return '—';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export default function AdminRecordings() {
  const [rows, setRows] = useState<RecordingRow[] | null>(null);
  const [msg, setMsg] = useState('');
  const [deleting, setDeleting] = useState('');
  const [confirmRoom, setConfirmRoom] = useState('');

  const load = useCallback(async () => {
    const r = await fetch('/api/admin/recordings').then(r => r.json()).catch(() => null);
    if (r?.recordings) setRows(r.recordings);
    else setMsg(r?.error || '載入失敗');
  }, []);

  useEffect(() => { load(); }, [load]);

  async function remove(room: string) {
    setDeleting(room); setMsg('');
    const r = await fetch(`/api/admin/recordings?room=${encodeURIComponent(room)}`, { method: 'DELETE' })
      .then(r => r.json()).catch(() => null);
    setDeleting(''); setConfirmRoom('');
    if (r?.ok) load();
    else setMsg(r?.error || '刪除失敗');
  }

  return (
    <div>
      <div style={{ display:'flex', alignItems:'baseline', gap:12, marginBottom:6 }}>
        <h1 style={{ fontSize:20, fontWeight:700, margin:0 }}>對話錄音</h1>
        <button onClick={() => { setRows(null); load(); }}
          style={{ marginLeft:'auto', padding:'6px 12px', borderRadius:6, border:'1px solid var(--border)',
            background:'transparent', color:'var(--muted)', fontSize:12.5, cursor:'pointer' }}>
          重新整理
        </button>
      </div>
      <div style={{ fontSize:13, color:'var(--muted)', marginBottom:18 }}>
        開了「對話錄音」的角色，每通即時語音通話一筆。播放連結 4 小時有效（私人資料，不公開）。
      </div>
      {msg && <div style={{ fontSize:13, color:'#c0392b', marginBottom:12 }}>{msg}</div>}

      {rows === null ? (
        <div style={{ color:'var(--muted)' }}>載入中…</div>
      ) : rows.length === 0 ? (
        <div style={{ color:'var(--muted)', fontSize:14, padding:'24px 0' }}>
          還沒有錄音。到「角色管理」把某個角色的「對話錄音」打開，下一通通話就會出現在這裡。
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {rows.map(r => {
            const st = STATUS_LABEL[r.status];
            return (
              <div key={r.roomName} style={{ border:'1px solid var(--border)', borderRadius:8,
                padding:'12px 14px', background:'var(--panel-2)', display:'flex', flexDirection:'column', gap:8 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                  <span style={{ fontSize:14, fontWeight:600 }}>{r.characterName || r.characterId}</span>
                  <span style={{ fontSize:12, color:'var(--muted)' }}>× {r.userId}</span>
                  <span style={{ fontSize:12, color:st.color, fontWeight:600 }}>{st.text}</span>
                  <span style={{ fontSize:12, color:'var(--muted)', marginLeft:'auto' }}>
                    {new Date(r.createdAt).toLocaleString('zh-TW', { hour12:false })}｜{fmtDuration(r.durationSec)}｜{fmtSize(r.sizeBytes)}
                  </span>
                </div>
                {r.status === 'done' && r.url && (
                  <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                    <audio controls preload="none" src={r.url} style={{ height:34, flex:'1 1 280px', minWidth:220 }} />
                    <a href={r.url} download={`${r.roomName}.mp4`}
                      style={{ fontSize:12.5, color:'var(--accent)', textDecoration:'none' }}>下載</a>
                    {confirmRoom === r.roomName ? (
                      <span style={{ display:'flex', gap:8, alignItems:'center' }}>
                        <button onClick={() => remove(r.roomName)} disabled={deleting === r.roomName}
                          style={{ padding:'4px 10px', borderRadius:6, border:'none', background:'#c0392b',
                            color:'#fff', fontSize:12, cursor:'pointer' }}>
                          {deleting === r.roomName ? '刪除中…' : '確認刪除'}
                        </button>
                        <button onClick={() => setConfirmRoom('')}
                          style={{ padding:'4px 10px', borderRadius:6, border:'1px solid var(--border)',
                            background:'transparent', color:'var(--muted)', fontSize:12, cursor:'pointer' }}>取消</button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmRoom(r.roomName)}
                        style={{ padding:'4px 10px', borderRadius:6, border:'1px solid var(--border)',
                          background:'transparent', color:'var(--muted)', fontSize:12, cursor:'pointer' }}>刪除</button>
                    )}
                  </div>
                )}
                {r.status === 'failed' && (
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <span style={{ fontSize:12.5, color:'var(--muted)' }}>本通未留下錄音檔（通話未建立或 egress 失敗）</span>
                    <button onClick={() => remove(r.roomName)} disabled={deleting === r.roomName}
                      style={{ padding:'4px 10px', borderRadius:6, border:'1px solid var(--border)',
                        background:'transparent', color:'var(--muted)', fontSize:12, cursor:'pointer' }}>
                      {deleting === r.roomName ? '清除中…' : '清除'}
                    </button>
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
