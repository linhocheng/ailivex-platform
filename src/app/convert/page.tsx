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
  hasAvatarV3: boolean;
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
          {(['avatar_iv', 'avatar_iii'] as const).map(v => {
            const selectedChar = avatarChars.find(c => c.id === charId);
            const v3Disabled = v === 'avatar_iii' && !!charId && !selectedChar?.hasAvatarV3;
            return (
              <button key={v}
                disabled={v3Disabled}
                onClick={() => !v3Disabled && setHeygenEngine(v)}
                title={v3Disabled ? '此角色尚未設定模型三分身' : undefined}
                style={{ padding: '6px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 500,
                  cursor: v3Disabled ? 'not-allowed' : 'pointer',
                  background: heygenEngine === v && !v3Disabled ? 'rgba(107,158,122,0.14)' : 'rgba(60,52,40,0.03)',
                  border: `1px solid ${heygenEngine === v && !v3Disabled ? 'rgba(107,158,122,0.45)' : 'var(--border)'}`,
                  color: v3Disabled ? 'var(--muted)' : heygenEngine === v ? '#6b9e7a' : 'var(--muted)',
                  opacity: v3Disabled ? 0.4 : 1 }}>
                {v === 'avatar_iv' ? '模型四' : '模型三'}
              </button>
            );
          })}
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

// ── Podcast 面板 ─────────────────────────────────────────────────────
interface PodcastLine { speaker: string; characterId: string; text: string; }

const POD_ACCENT = '#6b8ec4';
const POD_BG     = 'rgba(107,142,196,0.10)';
const POD_BORDER = 'rgba(107,142,196,0.35)';

function scriptToText(lines: PodcastLine[]): string {
  return lines.map(l => `[${l.speaker}]: ${l.text}`).join('\n');
}
function parseScript(text: string, nameToId: Record<string, string>): PodcastLine[] {
  return text.split('\n')
    .map(l => l.match(/^\[([^\]]+)\][:：]\s*(.+)/))
    .filter(Boolean)
    .map(m => ({ speaker: m![1].trim(), characterId: nameToId[m![1].trim()] ?? '', text: m![2].trim() }))
    .filter(l => l.characterId);
}

function PodcastPanel({ chars, onScripted }: { chars: ConvertChar[]; onScripted?: () => void }) {
  const podChars = chars.filter(c => c.voiceId);

  const [phase, setPhase]           = useState<'setup' | 'script' | 'audio'>('setup');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [topic, setTopic]            = useState('');
  const [focus, setFocus]            = useState('');
  const [minutes, setMinutes]        = useState(5);
  const [taskId, setTaskId]          = useState('');
  const [nameToId, setNameToId]      = useState<Record<string, string>>({});
  const [scriptText, setScriptText]  = useState('');
  const [loading, setLoading]        = useState(false);
  const [error, setError]            = useState('');
  const [audioUrl, setAudioUrl]      = useState('');

  function toggleChar(id: string) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function generateScript() {
    if (!selectedIds.length || loading) return;
    setLoading(true); setError('');

    // POST：立刻拿 taskId（背景生成中）
    const init = await fetch('/api/convert/podcast/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterIds: selectedIds, topic: topic.trim() || undefined,
        wordCount: minutes * 500, focus: focus.trim() || undefined }),
    }).then(r => r.json()).catch(() => null);

    if (!init?.taskId) {
      setLoading(false);
      setError(init?.error ?? '腳本生成失敗，請重試。');
      return;
    }

    const tid = init.taskId as string;
    setTaskId(tid);

    // 輪詢：每 5s 問一次，最多等 20 分鐘（12分鐘腳本約需 14 分鐘生成）
    const TIMEOUT = 20 * 60 * 1000;
    const start = Date.now();
    const map: Record<string, string> = {};
    selectedIds.forEach(id => {
      const c = chars.find(c => c.id === id);
      if (c) map[c.name] = id;
    });
    setNameToId(map);

    const poll = async () => {
      if (Date.now() - start > TIMEOUT) {
        setLoading(false);
        setError('生成超時，請重試。');
        return;
      }
      const r = await fetch(`/api/tasks/${tid}`).then(r => r.json()).catch(() => null);
      if (r?.status === 'scripted' && r.podcastScript?.length) {
        setLoading(false);
        setScriptText(scriptToText(r.podcastScript));
        setPhase('script');
        onScripted?.();
      } else if (r?.status === 'failed') {
        setLoading(false);
        setError(r.error ?? '腳本生成失敗，請重試。');
      } else {
        setTimeout(poll, 5000);
      }
    };
    setTimeout(poll, 3000);
  }

  async function generateAudio() {
    if (loading) return;
    setLoading(true); setError('');
    const editedScript = parseScript(scriptText, nameToId);
    const r = await fetch('/api/convert/podcast/generate-audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, script: editedScript.length ? editedScript : undefined }),
    }).then(r => r.json()).catch(() => null);
    setLoading(false);
    if (r?.audioUrl) {
      setAudioUrl(r.audioUrl);
      setPhase('audio');
    } else {
      setError(r?.error ?? '音檔生成失敗，請重試。');
    }
  }

  const selCount = selectedIds.length;
  const btnDisabled = !selCount || loading;

  return (
    <div style={{ padding: 24, borderRadius: 12, background: 'var(--panel)', border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* 標題 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, display: 'grid', placeItems: 'center',
          background: POD_BG, border: `1px solid ${POD_BORDER}`, color: POD_ACCENT }}>
          <Icon name="audio" size={18} />
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Podcast 對話生成</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
            選擇角色、輸入主題，AI 自動生成多人對話腳本並輸出音檔
          </div>
        </div>
      </div>

      {/* Phase: setup */}
      {phase === 'setup' && (<>
        {/* 角色選擇 */}
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8 }}>
            選擇參與角色
            {podChars.length === 0 && <span style={{ color: '#b5654a', marginLeft: 8 }}>（目前無設定語音的角色）</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {podChars.map(c => {
              const sel = selectedIds.includes(c.id);
              return (
                <button key={c.id} onClick={() => toggleChar(c.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', borderRadius: 8,
                    background: sel ? POD_BG : 'rgba(60,52,40,0.03)',
                    border: `1px solid ${sel ? POD_BORDER : 'var(--border)'}`,
                    cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                  <CharAvatar char={c} />
                  <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>{c.name}</span>
                  {selectedIds.indexOf(c.id) === 0 && sel && (
                    <span style={{ fontSize: 11, color: POD_ACCENT, marginLeft: 4 }}>第一聲音</span>
                  )}
                  {selectedIds.indexOf(c.id) > 0 && sel && (
                    <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 4 }}>第{selectedIds.indexOf(c.id) + 1}聲音</span>
                  )}
                  {sel && <Icon name="check" size={14} style={{ marginLeft: 'auto', color: POD_ACCENT }} />}
                </button>
              );
            })}
          </div>
          {selCount > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
              第一位選擇的角色為第一聲音，依序類推
            </div>
          )}
        </div>

        {/* 主題 */}
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 7 }}>對話主題（選填）</div>
          <textarea value={topic} onChange={e => setTopic(e.target.value)}
            placeholder="例：AI 對台灣媒體產業的影響…"
            rows={2}
            style={{ width: '100%', resize: 'vertical', fontSize: 13.5, lineHeight: 1.75,
              background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '10px 13px', color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box' }} />
        </div>

        {/* 焦點 */}
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 7 }}>討論焦點（選填）</div>
          <textarea value={focus} onChange={e => setFocus(e.target.value)}
            placeholder="例：一定要談到記者轉型的機會與挑戰，以及 AI 取代的邊界在哪裡…"
            rows={3}
            style={{ width: '100%', resize: 'vertical', fontSize: 13.5, lineHeight: 1.75,
              background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '10px 13px', color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box' }} />
        </div>

        {/* 時長 */}
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 7 }}>
            目標時長
            <span style={{ marginLeft: 8, color: 'var(--muted)', fontWeight: 400, opacity: 0.7 }}>
              約 {(minutes * 500).toLocaleString()} 字
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {([3, 5, 8, 12] as const).map(m => (
              <button key={m} onClick={() => setMinutes(m)}
                style={{ padding: '6px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 500,
                  cursor: 'pointer',
                  background: minutes === m ? POD_BG : 'rgba(60,52,40,0.03)',
                  border: `1px solid ${minutes === m ? POD_BORDER : 'var(--border)'}`,
                  color: minutes === m ? POD_ACCENT : 'var(--muted)' }}>
                {m} 分鐘
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div style={{ fontSize: 12.5, color: '#b5654a', padding: '9px 12px', borderRadius: 7,
            background: 'rgba(181,101,74,0.08)', border: '1px solid rgba(181,101,74,0.2)' }}>
            {error}
          </div>
        )}

        <button onClick={generateScript} disabled={btnDisabled}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '10px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
            background: btnDisabled ? 'rgba(60,52,40,0.05)' : POD_BG,
            border: `1px solid ${btnDisabled ? 'var(--border)' : POD_BORDER}`,
            color: btnDisabled ? 'var(--muted)' : POD_ACCENT,
            transition: 'all .2s', alignSelf: 'flex-end' }}>
          {loading ? <><Typing />生成腳本中…</> : <><Icon name="audio" size={15} />生成腳本</>}
        </button>
      </>)}

      {/* Phase: script */}
      {phase === 'script' && (<>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>對話腳本（可直接編輯）</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {scriptText.replace(/\[[^\]]+\][:：]\s*/g, '').replace(/\s+/g, '').length} 字
            </div>
          </div>
          <textarea value={scriptText} onChange={e => setScriptText(e.target.value)}
            rows={18}
            style={{ width: '100%', resize: 'vertical', fontSize: 13, lineHeight: 1.9,
              background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '12px 14px', color: 'var(--text)', fontFamily: 'monospace', boxSizing: 'border-box' }} />
        </div>

        {error && (
          <div style={{ fontSize: 12.5, color: '#b5654a', padding: '9px 12px', borderRadius: 7,
            background: 'rgba(181,101,74,0.08)', border: '1px solid rgba(181,101,74,0.2)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={() => { setPhase('setup'); setError(''); }} disabled={loading}
            style={{ padding: '10px 18px', borderRadius: 8, fontSize: 13.5, fontWeight: 500,
              cursor: 'pointer', background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)',
              color: 'var(--muted)' }}>
            重新生成
          </button>
          <button onClick={generateAudio} disabled={loading || !scriptText.trim()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '10px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
              background: (loading || !scriptText.trim()) ? 'rgba(60,52,40,0.05)' : POD_BG,
              border: `1px solid ${(loading || !scriptText.trim()) ? 'var(--border)' : POD_BORDER}`,
              color: (loading || !scriptText.trim()) ? 'var(--muted)' : POD_ACCENT,
              transition: 'all .2s' }}>
            {loading ? <><Typing />生成音檔中… 請稍候</> : <><Icon name="audio" size={15} />生成音檔</>}
          </button>
        </div>
      </>)}

      {/* Phase: audio */}
      {phase === 'audio' && (<>
        <div style={{ padding: '16px', borderRadius: 9, background: POD_BG, border: `1px solid ${POD_BORDER}` }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: POD_ACCENT, marginBottom: 10 }}>
            Podcast 音檔已生成
          </div>
          <audio controls src={audioUrl}
            style={{ width: '100%', borderRadius: 6, accentColor: POD_ACCENT }} />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={() => { setPhase('script'); setAudioUrl(''); setError(''); }}
            style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
              cursor: 'pointer', background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)',
              color: 'var(--muted)' }}>
            回到腳本
          </button>
          <button onClick={() => { setPhase('setup'); setAudioUrl(''); setScriptText(''); setError(''); }}
            style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
              cursor: 'pointer', background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)',
              color: 'var(--muted)' }}>
            新一集
          </button>
        </div>
      </>)}
    </div>
  );
}

// ── Podcast 腳本庫 ─────────────────────────────────────────────────────
interface ScriptItem {
  id: string;
  topic: string;
  focus: string;
  speakers: string[];
  wordCount: number;
  script: PodcastLine[];
  audioUrl: string | null;
  status: string;
  createdAt: number;
}

function PodcastLibrary({ chars, refreshSignal }: { chars: ConvertChar[]; refreshSignal: number }) {
  const [items, setItems]           = useState<ScriptItem[]>([]);
  const [loaded, setLoaded]         = useState(false);
  const [editing, setEditing]       = useState<string | null>(null);
  const [editText, setEditText]     = useState('');
  const [saving, setSaving]         = useState(false);
  const [deleting, setDeleting]     = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState<string | null>(null);
  const [audioUrls, setAudioUrls]   = useState<Record<string, string>>({});
  const [error, setError]           = useState('');

  const nameToId = Object.fromEntries(chars.map(c => [c.name, c.id]));

  async function load() {
    const r = await fetch('/api/convert/podcast/scripts').then(r => r.json()).catch(() => null);
    if (r?.scripts) { setItems(r.scripts); setLoaded(true); }
  }

  useEffect(() => { load(); }, [refreshSignal]); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function generateAudio(item: ScriptItem) {
    setAudioLoading(item.id); setError('');
    const r = await fetch('/api/convert/podcast/generate-audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: item.id, script: item.script }),
    }).then(r => r.json()).catch(() => null);
    setAudioLoading(null);
    if (r?.audioUrl) {
      setAudioUrls(prev => ({ ...prev, [item.id]: r.audioUrl }));
      setItems(prev => prev.map(it => it.id === item.id ? { ...it, audioUrl: r.audioUrl, status: 'done' } : it));
    } else {
      setError(r?.error ?? '音檔生成失敗，請重試。');
    }
  }

  if (!loaded) return null;
  if (items.length === 0) return null;

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
                  {liveAudioUrl ? (
                    <audio controls src={liveAudioUrl}
                      style={{ width: '100%', height: 36, borderRadius: 6, accentColor: POD_ACCENT }} />
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

// ── 主頁 ─────────────────────────────────────────────────────────────
export default function ConvertPage() {
  const [chars, setChars] = useState<ConvertChar[]>([]);
  const [charsLoaded, setCharsLoaded] = useState(false);
  const [trackedIds, setTrackedIds] = useState<Map<string, { kind: 'audio' | 'video'; label: string; createdAt: number }>>(new Map());
  const [taskStatuses, setTaskStatuses] = useState<Map<string, TaskStatus>>(new Map());
  const [libRefresh, setLibRefresh] = useState(0);

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
                口播稿生成音檔、多角色 Podcast、上傳音檔合成角色分身影片
              </p>
            </div>

            {!charsLoaded ? null : (<>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20, marginBottom: 20 }}>
                <AudioPanel chars={chars} onCreated={(id, label) => onTaskCreated(id, label, 'audio')} />
                <VideoPanel chars={chars} onCreated={(id, label) => onTaskCreated(id, label, 'video')} />
              </div>
              <div style={{ marginBottom: 32 }}>
                <PodcastPanel chars={chars} onScripted={() => setLibRefresh(n => n + 1)} />
              </div>
              <div style={{ marginBottom: 40 }}>
                <PodcastLibrary chars={chars} refreshSignal={libRefresh} />
              </div>
            </>)}

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
