'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { Wordmark, Icon, Tag, Dot, Typing, Ambient } from '@/app/_components/ui';
import { LogoutButton } from '@/app/_components/LogoutButton';

interface ConvertChar {
  id: string;
  name: string;
  avatarUrl: string;
  voiceId: string;
  heygenAvatarId: string;
}

interface TaskStatus {
  id: string;
  kind: 'audio' | 'video';
  label: string;
  status: string;
  audioUrl?: string;
  videoUrl?: string;
  error?: string;
  createdAt: number;
}

const STATUS_MAP: Record<string, { label: string; color: string; dot: string }> = {
  pending: { label: '排隊中', color: 'var(--muted)',    dot: 'rgba(255,255,255,0.3)' },
  running: { label: '生成中', color: '#c2954e',         dot: '#c2954e' },
  done:    { label: '完成',   color: 'var(--accent-2)', dot: '#6f8c5f' },
  failed:  { label: '失敗',   color: '#b5654a',         dot: '#b5654a' },
};

function NavLink({ href, active, icon, children }: { href: string; active?: boolean; icon?: string; children: React.ReactNode }) {
  return (
    <Link href={href} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
      background: active ? 'rgba(60,52,40,0.07)' : 'transparent',
      color: active ? 'var(--text)' : 'var(--muted)', padding: '9px 13px', borderRadius: 6,
      fontSize: 14, fontWeight: 500, minHeight: 40 }}>
      {icon && <Icon name={icon} size={16} />}{children}
    </Link>
  );
}

function CharAvatar({ char }: { char: ConvertChar }) {
  return char.avatarUrl
    ? <img src={char.avatarUrl} alt={char.name} style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
    : <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--border)', flexShrink: 0, display: 'grid', placeItems: 'center' }}>
        <Icon name="users" size={12} />
      </div>;
}

// ── 口播稿面板 ────────────────────────────────────────────────────────
function AudioPanel({ chars, onCreated }: { chars: ConvertChar[]; onCreated: (id: string, label: string) => void }) {
  const [text, setText] = useState('');
  const [charId, setCharId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const voiceChars = chars.filter(c => c.voiceId);

  async function submit() {
    if (!text.trim() || !charId || loading) return;
    setLoading(true);
    setError('');
    const r = await fetch('/api/convert/audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim(), characterId: charId }),
    }).then(r => r.json()).catch(() => null);
    setLoading(false);
    if (r?.ok) {
      const char = chars.find(c => c.id === charId);
      onCreated(r.taskId, `${char?.name ?? '角色'} 口播稿`);
      setText('');
    } else {
      setError(
        r?.error === 'no_voice' ? '此角色尚未設定語音，請聯絡管理員。'
        : r?.error === 'media_worker_not_configured' ? '語音服務暫時無法使用，請稍後再試。'
        : '生成失敗，請稍後再試。'
      );
    }
  }

  return (
    <div style={{ padding: '24px', borderRadius: 12, background: 'var(--panel)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, display: 'grid', placeItems: 'center',
          background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
          border: '1px solid color-mix(in oklab, var(--accent) 28%, transparent)', color: 'var(--accent)' }}>
          <Icon name="audio" size={18} />
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>新增口播稿</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>輸入文字，選擇角色語音生成音檔</div>
        </div>
      </div>

      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="在此輸入口播稿內容…"
        rows={6}
        style={{ width: '100%', resize: 'vertical', fontSize: 13.5, lineHeight: 1.75,
          background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', borderRadius: 8,
          padding: '10px 13px', color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box' }}
      />

      <div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 7 }}>選擇角色</div>
        {voiceChars.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: '10px 13px', borderRadius: 7,
            border: '1px solid var(--border)', background: 'rgba(60,52,40,0.03)' }}>
            目前沒有可用的語音角色
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {voiceChars.map(c => (
              <button key={c.id} onClick={() => setCharId(c.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', borderRadius: 8,
                  background: charId === c.id ? 'color-mix(in oklab, var(--accent) 10%, transparent)' : 'rgba(60,52,40,0.03)',
                  border: `1px solid ${charId === c.id ? 'color-mix(in oklab, var(--accent) 40%, transparent)' : 'var(--border)'}`,
                  cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                <CharAvatar char={c} />
                <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>{c.name}</span>
                {charId === c.id && <Icon name="check" size={14} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: '#b5654a', padding: '9px 12px', borderRadius: 7,
          background: 'rgba(181,101,74,0.08)', border: '1px solid rgba(181,101,74,0.2)' }}>
          {error}
        </div>
      )}

      <button onClick={submit} disabled={!text.trim() || !charId || loading || voiceChars.length === 0}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          padding: '10px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
          background: (!text.trim() || !charId || loading || voiceChars.length === 0)
            ? 'rgba(60,52,40,0.05)' : 'color-mix(in oklab, var(--accent) 18%, transparent)',
          border: `1px solid ${(!text.trim() || !charId || loading || voiceChars.length === 0)
            ? 'var(--border)' : 'color-mix(in oklab, var(--accent) 40%, transparent)'}`,
          color: (!text.trim() || !charId || loading || voiceChars.length === 0) ? 'var(--muted)' : 'var(--accent)',
          transition: 'all .2s', alignSelf: 'flex-end' }}>
        {loading ? <><Typing />生成中…</> : <><Icon name="audio" size={15} />生成音檔</>}
      </button>
    </div>
  );
}

// ── 生成影片面板 ──────────────────────────────────────────────────────
function VideoPanel({ chars, onCreated }: { chars: ConvertChar[]; onCreated: (id: string, label: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [charId, setCharId] = useState('');
  const [heygenEngine, setHeygenEngine] = useState<'avatar_iv' | 'avatar_iii'>('avatar_iv');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const avatarChars = chars.filter(c => c.heygenAvatarId);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('audio/')) setFile(f);
    else setError('請上傳音頻格式的檔案（mp3、wav、m4a 等）。');
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) { setFile(f); setError(''); }
  }

  async function submit() {
    if (!file || !charId || loading) return;
    setLoading(true);
    setError('');
    const fd = new FormData();
    fd.append('audioFile', file);
    fd.append('characterId', charId);
    fd.append('heygenEngine', heygenEngine);
    const r = await fetch('/api/convert/video', { method: 'POST', body: fd })
      .then(r => r.json()).catch(() => null);
    setLoading(false);
    if (r?.ok) {
      const char = chars.find(c => c.id === charId);
      onCreated(r.videoTaskId, `${char?.name ?? '角色'} 分身影片`);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } else {
      setError(
        r?.error === 'no_heygen_avatar' ? '此角色尚未設定 HeyGen 分身，請聯絡管理員。'
        : r?.error === 'media_worker_not_configured' ? '影片服務暫時無法使用，請稍後再試。'
        : r?.error === 'dispatch_failed' ? '影片任務送出失敗，請稍後再試。'
        : '生成失敗，請稍後再試。'
      );
    }
  }

  return (
    <div style={{ padding: '24px', borderRadius: 12, background: 'var(--panel)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, display: 'grid', placeItems: 'center',
          background: 'rgba(107,158,122,0.12)',
          border: '1px solid rgba(107,158,122,0.28)', color: '#6b9e7a' }}>
          <Icon name="image" size={18} />
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>生成影片</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>上傳音檔，使用角色分身生成短影音</div>
        </div>
      </div>

      {/* 音檔上傳區 */}
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{ padding: '24px 20px', borderRadius: 9, cursor: 'pointer', textAlign: 'center',
          border: `1.5px dashed ${dragging ? 'var(--accent)' : file ? 'rgba(107,158,122,0.5)' : 'var(--border)'}`,
          background: dragging ? 'color-mix(in oklab, var(--accent) 6%, transparent)'
            : file ? 'rgba(107,158,122,0.06)' : 'rgba(60,52,40,0.03)',
          transition: 'all .2s' }}>
        <input ref={fileRef} type="file" accept="audio/*" onChange={onFileChange} style={{ display: 'none' }} />
        {file ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <Icon name="audio" size={18} style={{ color: '#6b9e7a' }} />
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>{file.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                {(file.size / 1024 / 1024).toFixed(1)} MB
              </div>
            </div>
            <button onClick={e => { e.stopPropagation(); setFile(null); if (fileRef.current) fileRef.current.value = ''; }}
              style={{ marginLeft: 8, width: 24, height: 24, borderRadius: 6, border: '1px solid var(--border)',
                background: 'transparent', cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ) : (
          <>
            <Icon name="upload" size={22} style={{ color: 'var(--muted)', marginBottom: 8 }} />
            <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>點擊或拖曳音檔至此</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, opacity: 0.7 }}>支援 mp3、wav、m4a、aac</div>
          </>
        )}
      </div>

      {/* 角色選擇 */}
      <div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 7 }}>
          選擇角色分身
          {avatarChars.length === 0 && chars.length > 0 && (
            <span style={{ marginLeft: 8, color: '#b5654a' }}>（目前無可用分身）</span>
          )}
        </div>
        {avatarChars.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: '10px 13px', borderRadius: 7,
            border: '1px solid var(--border)', background: 'rgba(60,52,40,0.03)' }}>
            目前沒有設定 HeyGen 分身的角色。請聯絡管理員在角色設定中上傳分身照片。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {avatarChars.map(c => (
              <button key={c.id} onClick={() => setCharId(c.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', borderRadius: 8,
                  background: charId === c.id ? 'rgba(107,158,122,0.1)' : 'rgba(60,52,40,0.03)',
                  border: `1px solid ${charId === c.id ? 'rgba(107,158,122,0.45)' : 'var(--border)'}`,
                  cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                <CharAvatar char={c} />
                <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>{c.name}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Tag color="#6b9e7a" style={{ fontSize: 11 }}>有分身</Tag>
                  {charId === c.id && <Icon name="check" size={14} style={{ color: '#6b9e7a' }} />}
                </div>
              </button>
            ))}
            {chars.filter(c => !c.heygenAvatarId).map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', borderRadius: 8,
                background: 'rgba(60,52,40,0.02)', border: '1px solid var(--border)', opacity: 0.45 }}>
                <CharAvatar char={c} />
                <span style={{ fontSize: 13.5, color: 'var(--muted)' }}>{c.name}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>無分身</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: '#b5654a', padding: '9px 12px', borderRadius: 7,
          background: 'rgba(181,101,74,0.08)', border: '1px solid rgba(181,101,74,0.2)' }}>
          {error}
        </div>
      )}

      <div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 7 }}>HeyGen 模型版本</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['avatar_iv', 'avatar_iii'] as const).map(v => (
            <button key={v} onClick={() => setHeygenEngine(v)}
              style={{ padding: '6px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
                background: heygenEngine === v ? 'rgba(107,158,122,0.14)' : 'rgba(60,52,40,0.03)',
                border: `1px solid ${heygenEngine === v ? 'rgba(107,158,122,0.45)' : 'var(--border)'}`,
                color: heygenEngine === v ? '#6b9e7a' : 'var(--muted)' }}>
              {v === 'avatar_iv' ? '模型四' : '模型三'}
            </button>
          ))}
        </div>
      </div>

      <button onClick={submit} disabled={!file || !charId || loading || avatarChars.length === 0}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          padding: '10px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
          background: (!file || !charId || loading || avatarChars.length === 0)
            ? 'rgba(60,52,40,0.05)' : 'rgba(107,158,122,0.14)',
          border: `1px solid ${(!file || !charId || loading || avatarChars.length === 0)
            ? 'var(--border)' : 'rgba(107,158,122,0.42)'}`,
          color: (!file || !charId || loading || avatarChars.length === 0) ? 'var(--muted)' : '#6b9e7a',
          transition: 'all .2s', alignSelf: 'flex-end' }}>
        {loading ? <><Typing />上傳並生成中…</> : <><Icon name="image" size={15} />生成影片</>}
      </button>
    </div>
  );
}

// ── 任務狀態卡 ────────────────────────────────────────────────────────
function TaskCard({ task }: { task: TaskStatus }) {
  const st = STATUS_MAP[task.status] || STATUS_MAP.pending;
  const inProgress = task.status === 'pending' || task.status === 'running';

  return (
    <div className="ax-enter" style={{ padding: '16px 18px', borderRadius: 10, background: 'var(--panel)', border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: task.kind === 'audio' ? 'color-mix(in oklab, var(--accent) 12%, transparent)' : 'rgba(107,158,122,0.12)',
          color: task.kind === 'audio' ? 'var(--accent)' : '#6b9e7a',
          border: `1px solid ${task.kind === 'audio' ? 'color-mix(in oklab, var(--accent) 24%, transparent)' : 'rgba(107,158,122,0.28)'}` }}>
          <Icon name={task.kind === 'audio' ? 'audio' : 'image'} size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.label}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            {new Date(task.createdAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {inProgress && <Typing />}
          <Tag color={st.color}><Dot color={st.dot} pulse={inProgress} size={6} />{st.label}</Tag>
        </div>
      </div>
      {task.status === 'done' && task.audioUrl && (
        <audio controls src={task.audioUrl}
          style={{ width: '100%', height: 36, borderRadius: 6, marginTop: 12, accentColor: 'var(--accent)' }} />
      )}
      {task.status === 'done' && task.videoUrl && (
        <video controls src={task.videoUrl}
          style={{ width: '100%', borderRadius: 7, maxHeight: 320, marginTop: 12 }} />
      )}
      {task.status === 'failed' && task.error && (
        <div style={{ fontSize: 12, color: '#b5654a', marginTop: 8 }}>{task.error}</div>
      )}
    </div>
  );
}

// ── 主頁 ─────────────────────────────────────────────────────────────
export default function ConvertPage() {
  const [chars, setChars] = useState<ConvertChar[]>([]);
  const [charsLoaded, setCharsLoaded] = useState(false);
  const [trackedIds, setTrackedIds] = useState<Map<string, { kind: 'audio' | 'video'; label: string; createdAt: number }>>(new Map());
  const [taskStatuses, setTaskStatuses] = useState<Map<string, TaskStatus>>(new Map());

  useEffect(() => {
    fetch('/api/convert/characters')
      .then(r => r.json())
      .then(r => { setChars(r.characters || []); setCharsLoaded(true); })
      .catch(() => setCharsLoaded(true));
  }, []);

  function onTaskCreated(id: string, label: string, kind: 'audio' | 'video') {
    setTrackedIds(prev => {
      const next = new Map(prev);
      next.set(id, { kind, label, createdAt: Date.now() });
      return next;
    });
    // 立即加入 pending 狀態
    setTaskStatuses(prev => {
      const next = new Map(prev);
      next.set(id, { id, kind, label, status: 'pending', createdAt: Date.now() });
      return next;
    });
  }

  // 輪詢 gallery 更新狀態
  useEffect(() => {
    if (trackedIds.size === 0) return;
    const anyActive = Array.from(taskStatuses.values()).some(
      t => t.status === 'pending' || t.status === 'running'
    );
    if (!anyActive) return;

    const poll = async () => {
      const r = await fetch('/api/gallery').then(r => r.json()).catch(() => ({ tasks: [] }));
      const tasks: Array<{ id: string; status: string; audioUrl: string; videoUrl: string; error: string; createdAt: number }> = r.tasks || [];
      setTaskStatuses(prev => {
        const next = new Map(prev);
        for (const t of tasks) {
          if (!trackedIds.has(t.id)) continue;
          const meta = trackedIds.get(t.id)!;
          next.set(t.id, {
            id: t.id,
            kind: meta.kind,
            label: meta.label,
            status: t.status,
            audioUrl: t.audioUrl || undefined,
            videoUrl: t.videoUrl || undefined,
            error: t.error || undefined,
            createdAt: t.createdAt || meta.createdAt,
          });
        }
        return next;
      });
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [trackedIds, taskStatuses]);

  const sortedTasks = Array.from(taskStatuses.values()).sort((a, b) => b.createdAt - a.createdAt);
  const anyActive = sortedTasks.some(t => t.status === 'pending' || t.status === 'running');

  return (
    <>
      <Ambient />
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px clamp(16px,4vw,26px)', borderBottom: '1px solid var(--border)',
          position: 'relative', zIndex: 5, background: 'var(--bg)' }}>
          <Link href="/lobby"><Wordmark size={19} /></Link>
          <nav style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <NavLink href="/lobby">大廳</NavLink>
            <NavLink href="/documents" icon="doc">我的文件</NavLink>
            <NavLink href="/gallery" icon="image">媒體庫</NavLink>
            <NavLink href="/stories" icon="image">故事板</NavLink>
            <NavLink href="/convert" active icon="audio">素材轉換區</NavLink>
            <LogoutButton style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(60,52,40,0.045)',
              border: '1px solid var(--border)', borderRadius: 6, padding: '8px 14px', fontSize: 13,
              fontWeight: 500, color: 'var(--text)', cursor: 'pointer' }}>
              <Icon name="logout" size={16} />登出
            </LogoutButton>
          </nav>
        </header>

        <main style={{ flex: 1, overflowY: 'auto', padding: '40px clamp(20px,5vw,64px) 64px' }}>
          <div style={{ maxWidth: 900, margin: '0 auto' }}>

            <div className="ax-enter" style={{ marginBottom: 36 }}>
              <h1 style={{ fontSize: 30, margin: 0, fontWeight: 600, letterSpacing: '-0.02em' }}>素材轉換區</h1>
              <p style={{ fontSize: 14.5, color: 'var(--muted)', margin: '7px 0 0' }}>
                手動輸入口播稿生成音檔，或上傳音檔合成角色分身影片
              </p>
            </div>

            {!charsLoaded ? null : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20, marginBottom: 40 }}>
                <AudioPanel chars={chars} onCreated={(id, label) => onTaskCreated(id, label, 'audio')} />
                <VideoPanel chars={chars} onCreated={(id, label) => onTaskCreated(id, label, 'video')} />
              </div>
            )}

            {sortedTasks.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>本次任務進度</div>
                  {anyActive && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Dot color="var(--accent-2)" pulse size={6} />每 5 秒自動更新
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sortedTasks.map(t => <TaskCard key={t.id} task={t} />)}
                </div>
              </div>
            )}

          </div>
        </main>
      </div>
    </>
  );
}
