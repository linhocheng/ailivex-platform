'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { Wordmark, Icon, Tag, Dot, Typing, EmptyState, Ambient } from '@/app/_components/ui';
import { LogoutButton } from '@/app/_components/LogoutButton';

interface MediaTask {
  id: string;
  type: string;
  characterId: string;
  intent: string;
  summary: string;
  status: string;
  imageUrl: string;
  audioUrl: string;
  videoUrl: string;
  videoTaskId: string;
  klingVideoTaskId: string;
  source: string;
  scriptText: string;
  voiceId: string;
  storyText: string;
  parentTaskId: string;
  order: number;
  error: string;
  createdAt: number;
  completedAt: number;
}

const STATUS: Record<string, { label: string; color: string; dot: string }> = {
  pending:   { label: '排隊中', color: 'var(--muted)',    dot: 'rgba(255,255,255,0.3)' },
  running:   { label: '生成中', color: '#c2954e',         dot: '#c2954e' },
  done:      { label: '完成',   color: 'var(--accent-2)',  dot: '#6f8c5f' },
  failed:    { label: '失敗',   color: '#b5654a',          dot: '#b5654a' },
  draft:     { label: '待確認', color: '#8c7ec2',          dot: '#8c7ec2' },
  submitted: { label: '已送出', color: 'var(--muted)',    dot: 'rgba(255,255,255,0.3)' },
};

function fmt(ms: number) {
  return ms ? new Date(ms).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

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

function RowButton({ onClick, icon, children, primary }: { onClick: () => void; icon: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <button onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
      background: primary ? 'color-mix(in oklab, var(--accent) 18%, transparent)' : 'rgba(60,52,40,0.045)',
      border: `1px solid ${primary ? 'color-mix(in oklab, var(--accent) 35%, transparent)' : 'var(--border)'}`,
      borderRadius: 6, padding: '7px 12px', fontSize: 13, fontWeight: 500,
      color: primary ? 'var(--accent)' : 'var(--muted)', cursor: 'pointer', minHeight: 36 }}>
      <Icon name={icon} size={15} />{children}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 12, letterSpacing: '0.02em' }}>
      {children}
    </div>
  );
}

// ── 腳本草稿卡 ────────────────────────────────────────────────────────
function ScriptDraftCard({ task, onDelete, onGenerated }: { task: MediaTask; onDelete: (t: MediaTask) => void; onGenerated: () => void }) {
  const [text, setText] = useState(task.scriptText || '');
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState('');

  async function generate() {
    if (!text.trim()) return;
    setLoading(true);
    setLastError('');
    const r = await fetch(`/api/tasks/${task.id}/generate-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then(r => r.json()).catch(() => null);
    setLoading(false);
    if (r?.ok) { onGenerated(); }
    else { setLastError('生成失敗，請稍後再試。'); }
  }

  return (
    <div className="ax-enter" style={{ padding: '18px 20px', borderRadius: 10, background: 'var(--panel)',
      border: '1px solid color-mix(in oklab, #8c7ec2 28%, var(--border))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ width: 36, height: 36, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: 'rgba(140,126,194,0.12)', color: '#8c7ec2', border: '1px solid rgba(140,126,194,0.28)' }}>
          <Icon name="doc" size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.intent || '腳本草稿'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{fmt(task.createdAt)}</div>
        </div>
        <Tag color="#8c7ec2"><Dot color="#8c7ec2" size={6} />腳本草稿</Tag>
      </div>

      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        rows={6}
        style={{ width: '100%', resize: 'vertical', fontSize: 13.5, lineHeight: 1.7,
          background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', borderRadius: 7,
          padding: '10px 13px', color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box',
          marginBottom: 12 }}
      />
      {lastError && (
        <div style={{ fontSize: 12.5, color: '#b5654a', marginBottom: 10 }}>{lastError}</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <RowButton onClick={() => onDelete(task)} icon="trash">刪除</RowButton>
        <RowButton onClick={generate} icon="audio" primary>
          {loading ? '處理中…' : '生成音檔'}
        </RowButton>
      </div>
    </div>
  );
}

// ── 故事草稿卡 ───────────────────────────────────────────────────────
const STORY_STATUS: Record<string, { label: string; color: string; dot: string }> = {
  pending:   { label: '排隊中',   color: 'var(--muted)',    dot: 'rgba(255,255,255,0.3)' },
  running:   { label: '寫作中',   color: '#c2954e',         dot: '#c2954e' },
  scripting: { label: '寫作中',   color: '#c2954e',         dot: '#c2954e' },
  scripted:  { label: '故事完成', color: '#8c7ec2',         dot: '#8c7ec2' },
  ready:     { label: '圖卡就緒', color: 'var(--accent-2)', dot: '#6f8c5f' },
  done:      { label: '完成',     color: 'var(--accent-2)', dot: '#6f8c5f' },
  failed:    { label: '失敗',     color: '#b5654a',         dot: '#b5654a' },
};

function StoryDraftCard({ task, onDelete }: { task: MediaTask; onDelete: (t: MediaTask) => void }) {
  const st = STORY_STATUS[task.status] || STORY_STATUS.pending;
  const inProgress = task.status === 'pending' || task.status === 'running' || task.status === 'scripting';

  return (
    <div className="ax-enter" style={{ padding: '18px 20px', borderRadius: 10, background: 'var(--panel)',
      border: '1px solid color-mix(in oklab, #6b9e7a 28%, var(--border))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: 'rgba(107,158,122,0.12)', color: '#6b9e7a', border: '1px solid rgba(107,158,122,0.28)' }}>
          <Icon name="image" size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.intent || '故事板'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{fmt(task.createdAt)}</div>
        </div>
        <Tag color="#6b9e7a"><Dot color="#6b9e7a" size={6} />故事板</Tag>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
        <Tag color={st.color}><Dot color={st.dot} pulse={inProgress} size={6} />{st.label}</Tag>
        <div style={{ display: 'flex', gap: 8 }}>
          <RowButton onClick={() => onDelete(task)} icon="trash">刪除</RowButton>
          <Link href={`/stories/${task.id}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'color-mix(in oklab, var(--accent) 18%, transparent)',
              border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)',
              borderRadius: 6, padding: '7px 12px', fontSize: 13, fontWeight: 500,
              color: 'var(--accent)', textDecoration: 'none', minHeight: 36 }}>
            <Icon name="image" size={15} />前往故事板
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── 音檔卡 ────────────────────────────────────────────────────────────
function AudioCard({ task, tasks, onDelete, onGenerated }: { task: MediaTask; tasks: MediaTask[]; onDelete: (t: MediaTask) => void; onGenerated: () => void }) {
  const [h, setH] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState('');
  const [motionPrompt, setMotionPrompt] = useState('speak warmly to camera with a gentle smile, occasionally nod and use light hand gestures to emphasize key points');
  const [klingLoading, setKlingLoading] = useState(false);
  const [klingError, setKlingError] = useState('');
  const inProgress = task.status === 'pending' || task.status === 'running';
  const linkedVideo = tasks.find(t => t.id === task.videoTaskId);
  const videoFailed = linkedVideo?.status === 'failed';
  const linkedKling = tasks.find(t => t.id === task.klingVideoTaskId);
  const klingFailed = linkedKling?.status === 'failed';
  const st = STATUS[task.status] || STATUS.pending;

  async function generateVideo() {
    setVideoLoading(true);
    setVideoError('');
    const r = await fetch(`/api/tasks/${task.id}/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motionPrompt: motionPrompt.trim() }),
    }).then(res => res.json()).catch(() => null);
    setVideoLoading(false);
    if (r?.ok) { onGenerated(); }
    else {
      setVideoError(
        r?.error === 'no_heygen_avatar' || r?.error === 'no_avatar_url'
          ? '角色尚未設定 HeyGen 分身照片，請先至後台上傳。'
          : '生成失敗，請稍後再試。'
      );
    }
  }

  async function generateKlingVideo() {
    setKlingLoading(true);
    setKlingError('');
    const r = await fetch(`/api/tasks/${task.id}/generate-video-kling`, { method: 'POST' })
      .then(res => res.json()).catch(() => null);
    setKlingLoading(false);
    if (r?.ok) { onGenerated(); }
    else {
      setKlingError(
        r?.error === 'no_avatar_url' ? '角色尚未設定頭像，請先至後台上傳。'
        : r?.error === 'fal_not_configured' ? 'Kling 尚未設定（FAL_KEY 缺失）。'
        : '生成失敗，請稍後再試。'
      );
    }
  }

  return (
    <div className="ax-enter" onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ padding: '16px 18px', borderRadius: 10, background: 'var(--panel)',
        border: '1px solid', borderColor: h ? 'var(--border-strong)' : 'var(--border)',
        transition: 'border-color .2s' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: task.audioUrl ? 12 : 0 }}>
        <div style={{ width: 36, height: 36, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: 'color-mix(in oklab, var(--accent) 12%, transparent)', color: 'var(--accent)',
          border: '1px solid color-mix(in oklab, var(--accent) 24%, transparent)' }}>
          <Icon name="audio" size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.intent || '音檔'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{fmt(task.completedAt || task.createdAt)}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {inProgress && <Typing />}
          <Tag color={st.color}><Dot color={st.dot} pulse={inProgress} size={6} />{st.label}</Tag>
          <RowButton onClick={() => onDelete(task)} icon="trash">刪除</RowButton>
        </div>
      </div>
      {task.audioUrl && (
        <audio controls src={task.audioUrl}
          style={{ width: '100%', height: 36, borderRadius: 6, accentColor: 'var(--accent)' }} />
      )}
      {task.audioUrl && task.status === 'done' && (
        <div style={{ marginTop: 8 }}>
          {(videoError || klingError) && (
            <div style={{ fontSize: 12.5, color: '#b5654a', marginBottom: 8, padding: '8px 10px',
              background: 'rgba(181,101,74,0.08)', borderRadius: 6, border: '1px solid rgba(181,101,74,0.2)' }}>
              {videoError || klingError}
            </div>
          )}
          {!(task.videoTaskId && !videoFailed) && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>動作描述（Motion Prompt）</div>
              <textarea
                value={motionPrompt}
                onChange={e => setMotionPrompt(e.target.value)}
                rows={2}
                style={{ width: '100%', fontSize: 12.5, padding: '7px 10px', borderRadius: 6,
                  background: 'rgba(60,52,40,0.045)', border: '1px solid var(--border)',
                  color: 'var(--text)', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {/* HeyGen 按鈕 */}
            {task.videoTaskId && !videoFailed ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Dot color="var(--accent-2)" size={6} />HeyGen 已送出
              </div>
            ) : (
              <button onClick={generateVideo} disabled={videoLoading}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: videoFailed ? 'color-mix(in oklab, #b5654a 18%, transparent)' : 'rgba(60,52,40,0.045)',
                  border: `1px solid ${videoFailed ? 'color-mix(in oklab, #b5654a 35%, transparent)' : 'var(--border)'}`,
                  borderRadius: 6, padding: '7px 12px', fontSize: 13, fontWeight: 500,
                  color: videoFailed ? '#b5654a' : 'var(--muted)',
                  cursor: videoLoading ? 'not-allowed' : 'pointer',
                  opacity: videoLoading ? 0.7 : 1, minHeight: 36, transition: 'opacity .2s' }}>
                {videoLoading ? <><Typing />生成中…</> : videoFailed
                  ? <><Icon name="image" size={15} />重試 HeyGen</>
                  : <><Icon name="image" size={15} />HeyGen</>}
              </button>
            )}
            {/* Kling 按鈕 */}
            {task.klingVideoTaskId && !klingFailed ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Dot color="var(--accent-2)" size={6} />Kling 已送出
              </div>
            ) : (
              <button onClick={generateKlingVideo} disabled={klingLoading}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: klingFailed
                    ? 'color-mix(in oklab, #b5654a 18%, transparent)'
                    : 'color-mix(in oklab, var(--accent) 18%, transparent)',
                  border: `1px solid ${klingFailed
                    ? 'color-mix(in oklab, #b5654a 35%, transparent)'
                    : 'color-mix(in oklab, var(--accent) 35%, transparent)'}`,
                  borderRadius: 6, padding: '7px 12px', fontSize: 13, fontWeight: 500,
                  color: klingFailed ? '#b5654a' : 'var(--accent)',
                  cursor: klingLoading ? 'not-allowed' : 'pointer',
                  opacity: klingLoading ? 0.7 : 1, minHeight: 36, transition: 'opacity .2s' }}>
                {klingLoading ? <><Typing />生成中…</> : klingFailed
                  ? <><Icon name="image" size={15} />重試 Kling</>
                  : <><Icon name="image" size={15} />Kling 生成</>}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 影片卡 ────────────────────────────────────────────────────────────────────
function VideoCard({ task, onDelete }: { task: MediaTask; onDelete: (t: MediaTask) => void }) {
  const inProgress = task.status === 'pending' || task.status === 'running';
  const st = STATUS[task.status] || STATUS.pending;

  return (
    <div className="ax-enter" style={{ padding: '16px 18px', borderRadius: 10, background: 'var(--panel)',
      border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: task.videoUrl ? 12 : 0 }}>
        <div style={{ width: 36, height: 36, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: 'rgba(107,158,122,0.12)', color: '#6b9e7a',
          border: '1px solid rgba(107,158,122,0.28)' }}>
          <Icon name="image" size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.intent || '分身短影音'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{fmt(task.completedAt || task.createdAt)}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {inProgress && <Typing />}
          <Tag color={st.color}><Dot color={st.dot} pulse={inProgress} size={6} />{st.label}</Tag>
          <RowButton onClick={() => onDelete(task)} icon="trash">刪除</RowButton>
        </div>
      </div>
      {task.videoUrl && (
        <video controls src={task.videoUrl} style={{ width: '100%', borderRadius: 7, maxHeight: 360 }} />
      )}
      {inProgress && !task.videoUrl && (
        <div style={{ padding: '12px 0', fontSize: 13, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Typing />{task.source === 'kling' ? 'Kling 生成中（約 2–4 分鐘）…' : 'HeyGen 生成中（約 1–2 分鐘）…'}
        </div>
      )}
    </div>
  );
}

// ── 圖片元件（不變）──────────────────────────────────────────────────
function ScheduleRow({ task, onDelete }: { task: MediaTask; onDelete: (t: MediaTask) => void }) {
  const st = STATUS[task.status] || STATUS.pending;
  const inProgress = task.status === 'pending' || task.status === 'running';
  return (
    <div className="ax-enter" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', rowGap: 12,
      padding: '14px 18px', borderRadius: 8, background: 'var(--panel)', border: '1px solid var(--border)' }}>
      <div style={{ width: 38, height: 38, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
        background: 'color-mix(in oklab, var(--accent) 14%, transparent)', color: 'var(--accent)',
        border: '1px solid color-mix(in oklab, var(--accent) 24%, transparent)' }}>
        <Icon name="image" size={19} />
      </div>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 500, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.intent || '製圖任務'}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{fmt(task.createdAt)}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {inProgress && <Typing />}
        <Tag color={st.color}><Dot color={st.dot} pulse={inProgress} size={6} />{st.label}</Tag>
        <RowButton onClick={() => onDelete(task)} icon="trash">取消</RowButton>
      </div>
    </div>
  );
}

function GalleryCard({ task, onOpen, onDelete }: { task: MediaTask; onOpen: () => void; onDelete: (t: MediaTask) => void }) {
  const [h, setH] = useState(false);
  return (
    <div className="ax-enter" onClick={onOpen}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ cursor: 'pointer', position: 'relative', borderRadius: 10, overflow: 'hidden', background: 'var(--panel)',
        border: '1px solid', borderColor: h ? 'var(--border-strong)' : 'var(--border)',
        boxShadow: h ? 'var(--shadow-hover)' : 'var(--shadow)',
        transform: h ? 'translateY(-3px)' : 'none', transition: 'transform .25s, box-shadow .25s, border-color .25s' }}>
      <button onClick={e => { e.stopPropagation(); onDelete(task); }}
        title="刪除這張圖片"
        style={{ position: 'absolute', top: 10, right: 10, zIndex: 2, display: 'grid', placeItems: 'center',
          width: 32, height: 32, borderRadius: 7, cursor: 'pointer',
          background: 'rgba(20,16,12,0.62)', border: '1px solid rgba(255,255,255,0.18)', color: '#f3f1ea',
          opacity: h ? 1 : 0, transition: 'opacity .2s', backdropFilter: 'blur(3px)' }}>
        <Icon name="trash" size={16} />
      </button>
      <div style={{ aspectRatio: '1 / 1', background: 'rgba(60,52,40,0.05)', overflow: 'hidden' }}>
        <img src={task.imageUrl} alt={task.intent}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </div>
      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.intent || '未命名'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{fmt(task.completedAt || task.createdAt)}</div>
      </div>
    </div>
  );
}

function Lightbox({ task, onClose, onDelete }: { task: MediaTask; onClose: () => void; onDelete: (t: MediaTask) => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center',
      background: 'rgba(20,16,12,0.72)', padding: 'clamp(16px,5vw,48px)', backdropFilter: 'blur(4px)' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: 880, width: '100%', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', gap: 14 }}>
        <img src={task.imageUrl} alt={task.intent}
          style={{ maxWidth: '100%', maxHeight: '74vh', objectFit: 'contain', borderRadius: 10,
            boxShadow: '0 24px 60px rgba(0,0,0,0.4)', margin: '0 auto' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ color: '#f3f1ea', fontSize: 14.5, fontWeight: 500 }}>{task.intent || '未命名'}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => onDelete(task)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 500, cursor: 'pointer',
                color: '#f3f1ea', background: 'rgba(181,101,74,0.32)', border: '1px solid rgba(181,101,74,0.5)',
                borderRadius: 6, padding: '8px 14px' }}>
              <Icon name="trash" size={15} />刪除
            </button>
            <a href={task.imageUrl} target="_blank" rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 500,
                color: '#f3f1ea', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: 6, padding: '8px 14px', textDecoration: 'none' }}>
              <Icon name="external" size={15} />原圖
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 主頁 ─────────────────────────────────────────────────────────────
export default function Gallery() {
  const [tasks, setTasks] = useState<MediaTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<MediaTask | null>(null);

  async function load() {
    const r = await fetch('/api/gallery').then(r => r.json()).catch(() => ({ tasks: [] }));
    setTasks(r.tasks || []);
    setLoaded(true);
  }

  async function del(task: MediaTask) {
    const verb = task.status === 'pending' || task.status === 'running' ? '取消' : '刪除';
    if (!confirm(`確定${verb}「${task.intent || '這個任務'}」？此操作無法復原。`)) return;
    setTasks(prev => prev.filter(t => t.id !== task.id));
    if (open?.id === task.id) setOpen(null);
    const r = await fetch(`/api/gallery/${task.id}`, { method: 'DELETE' }).then(r => r.json()).catch(() => null);
    if (!r?.ok) { alert(`${verb}失敗，請稍後再試。`); load(); }
    else if (r.warnings?.length) console.warn('[gallery] 部分來源未清乾淨：', r.warnings);
  }

  // 分類
  const storyDrafts   = tasks.filter(t => t.type === 'story_draft');
  const standaloneImgs = tasks.filter(t => t.type === 'image_generation' && !t.parentTaskId);
  const imgActive  = standaloneImgs.filter(t => t.status === 'pending' || t.status === 'running');
  const imgFailed  = standaloneImgs.filter(t => t.status === 'failed');
  const imgDone    = standaloneImgs.filter(t => t.status === 'done' && t.imageUrl);
  const drafts     = tasks.filter(t => t.type === 'script_draft');
  const audioTasks = tasks.filter(t => t.type === 'audio_generation');
  const videoTasks = tasks.filter(t => t.type === 'video_generation');

  const anyActive = imgActive.length > 0 || audioTasks.some(t => t.status === 'pending' || t.status === 'running')
    || storyDrafts.some(t => t.status === 'pending' || t.status === 'running' || t.status === 'scripting')
    || videoTasks.some(t => t.status === 'pending' || t.status === 'running');
  const hasContent = imgDone.length > 0 || drafts.length > 0 || audioTasks.length > 0
    || imgActive.length > 0 || imgFailed.length > 0 || storyDrafts.length > 0
    || videoTasks.length > 0;

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [anyActive]);

  // Kling 補救：偵測 running > 10 分鐘的 Kling video task，主動去查 fal.ai 補寫結果
  const recoveringRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = Date.now();
    const stuckKling = videoTasks.filter(t =>
      t.source === 'kling' && t.status === 'running' && now - t.createdAt > 10 * 60 * 1000
    );
    for (const t of stuckKling) {
      if (recoveringRef.current.has(t.id)) continue;
      recoveringRef.current.add(t.id);
      fetch(`/api/tasks/${t.id}/kling-recover`, { method: 'POST' })
        .then(r => r.json())
        .then(data => {
          if (data.status === 'done' || data.status === 'failed') load();
          else recoveringRef.current.delete(t.id); // 還在跑，下次繼續檢查
        })
        .catch(() => recoveringRef.current.delete(t.id));
    }
  }, [videoTasks]);

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
            <NavLink href="/gallery" active icon="image">媒體庫</NavLink>
            <NavLink href="/stories" icon="image">故事板</NavLink>
            <NavLink href="/convert" icon="audio">素材轉換區</NavLink>
            <LogoutButton style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(60,52,40,0.045)',
              border: '1px solid var(--border)', borderRadius: 6, padding: '8px 14px', fontSize: 13,
              fontWeight: 500, color: 'var(--text)', cursor: 'pointer' }}>
              <Icon name="logout" size={16} />登出
            </LogoutButton>
          </nav>
        </header>

        <main style={{ flex: 1, overflowY: 'auto', padding: '40px clamp(20px,5vw,64px) 64px' }}>
          <div style={{ maxWidth: 1040, margin: '0 auto' }}>

            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 32, gap: 16 }} className="ax-enter">
              <div>
                <h1 style={{ fontSize: 30, margin: 0, fontWeight: 600, letterSpacing: '-0.02em' }}>媒體庫</h1>
                <p style={{ fontSize: 14.5, color: 'var(--muted)', margin: '7px 0 0' }}>角色為你生成的圖片、音檔與腳本草稿</p>
              </div>
              {anyActive && (
                <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Dot color="var(--accent-2)" pulse size={6} />每 5 秒自動更新
                </div>
              )}
            </div>

            {!loaded ? null : !hasContent ? (
              <EmptyState icon="image" title="媒體庫還是空的"
                desc="在對話中告訴角色幫你畫圖、寫腳本或生成音檔，完成後會出現在這裡。" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>

                {/* 故事草稿 + 故事板 */}
                {storyDrafts.length > 0 && (
                  <section>
                    <SectionLabel>故事板</SectionLabel>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                      {storyDrafts.map(t => (
                        <StoryDraftCard key={t.id} task={t} onDelete={del} />
                      ))}
                    </div>
                  </section>
                )}

                {/* 腳本草稿 */}
                {drafts.length > 0 && (
                  <section>
                    <SectionLabel>腳本草稿</SectionLabel>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {drafts.map(t => (
                        <ScriptDraftCard key={t.id} task={t} onDelete={del} onGenerated={load} />
                      ))}
                    </div>
                  </section>
                )}

                {/* 音檔 */}
                {audioTasks.length > 0 && (
                  <section>
                    <SectionLabel>音檔</SectionLabel>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {audioTasks.map(t => <AudioCard key={t.id} task={t} tasks={tasks} onDelete={del} onGenerated={load} />)}
                    </div>
                  </section>
                )}

                {/* 分身短影音 */}
                {videoTasks.length > 0 && (
                  <section>
                    <SectionLabel>分身短影音</SectionLabel>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {videoTasks.map(t => <VideoCard key={t.id} task={t} onDelete={del} />)}
                    </div>
                  </section>
                )}

                {/* 圖片 — 進行中 */}
                {(imgActive.length > 0 || imgFailed.length > 0) && (
                  <section>
                    <SectionLabel>圖片任務</SectionLabel>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {imgActive.map(t => <ScheduleRow key={t.id} task={t} onDelete={del} />)}
                      {imgFailed.map(t => (
                        <div key={t.id} className="ax-enter" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', rowGap: 12,
                          padding: '14px 18px', borderRadius: 8, background: 'var(--panel)', border: '1px solid var(--border)' }}>
                          <div style={{ width: 38, height: 38, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
                            background: 'rgba(181,101,74,0.1)', color: '#b5654a', border: '1px solid rgba(181,101,74,0.28)' }}>
                            <Icon name="image" size={19} />
                          </div>
                          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                            <div style={{ fontSize: 14.5, fontWeight: 500, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {t.intent || '製圖任務'}
                            </div>
                            <div style={{ fontSize: 12.5, color: '#b5654a' }}>{t.error || '生成失敗'}</div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <Tag color="#b5654a"><Dot color="#b5654a" size={6} />失敗</Tag>
                            <RowButton onClick={() => del(t)} icon="trash">刪除</RowButton>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* 圖庫 */}
                {imgDone.length > 0 && (
                  <section>
                    {(imgActive.length > 0 || imgFailed.length > 0) && <SectionLabel>已完成圖片</SectionLabel>}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
                      {imgDone.map((t, i) => (
                        <div key={t.id} style={{ animationDelay: `${i * 0.04}s` }}>
                          <GalleryCard task={t} onOpen={() => setOpen(t)} onDelete={del} />
                        </div>
                      ))}
                    </div>
                  </section>
                )}

              </div>
            )}
          </div>
        </main>
      </div>
      {open && <Lightbox task={open} onClose={() => setOpen(null)} onDelete={del} />}
    </>
  );
}
