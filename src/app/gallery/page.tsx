'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wordmark, Icon, Tag, Dot, Typing, EmptyState, Ambient } from '@/app/_components/ui';
import { LogoutButton } from '@/app/_components/LogoutButton';

interface ImgTask {
  id: string;
  characterId: string;
  intent: string;
  summary: string;
  status: string;
  imageUrl: string;
  error: string;
  createdAt: number;
  completedAt: number;
}

const STATUS: Record<string, { label: string; color: string; dot: string }> = {
  pending: { label: '排隊中', color: 'var(--muted)',    dot: 'rgba(255,255,255,0.3)' },
  running: { label: '製圖中', color: '#c2954e',         dot: '#c2954e' },
  done:    { label: '完成',   color: 'var(--accent-2)',  dot: '#6f8c5f' },
  failed:  { label: '失敗',   color: '#b5654a',          dot: '#b5654a' },
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

function RowButton({ onClick, icon, children }: { onClick: () => void; icon: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
      background: 'rgba(60,52,40,0.045)', border: '1px solid var(--border)', borderRadius: 6,
      padding: '7px 12px', fontSize: 13, fontWeight: 500, color: 'var(--muted)', cursor: 'pointer', minHeight: 36 }}>
      <Icon name={icon} size={15} />{children}
    </button>
  );
}

function ScheduleRow({ task, onDelete }: { task: ImgTask; onDelete: (t: ImgTask) => void }) {
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

function GalleryCard({ task, onOpen, onDelete }: { task: ImgTask; onOpen: () => void; onDelete: (t: ImgTask) => void }) {
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

function Lightbox({ task, onClose, onDelete }: { task: ImgTask; onClose: () => void; onDelete: (t: ImgTask) => void }) {
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

export default function Gallery() {
  const [tasks, setTasks] = useState<ImgTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<ImgTask | null>(null);

  async function load() {
    const r = await fetch('/api/gallery').then(r => r.json()).catch(() => ({ tasks: [] }));
    setTasks(r.tasks || []);
    setLoaded(true);
  }

  async function del(task: ImgTask) {
    const verb = task.status === 'pending' || task.status === 'running' ? '取消' : '刪除';
    if (!confirm(`確定${verb}「${task.intent || '這個任務'}」？此操作會從根本源頭清除，無法復原。`)) return;
    setTasks(prev => prev.filter(t => t.id !== task.id));
    if (open?.id === task.id) setOpen(null);
    const r = await fetch(`/api/gallery/${task.id}`, { method: 'DELETE' }).then(r => r.json()).catch(() => null);
    if (!r?.ok) { alert(`${verb}失敗，請稍後再試。`); load(); }
    else if (r.warnings?.length) console.warn('[gallery] 部分來源未清乾淨：', r.warnings);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const active = tasks.filter(t => t.status === 'pending' || t.status === 'running');
  const failed = tasks.filter(t => t.status === 'failed');
  const done = tasks.filter(t => t.status === 'done' && t.imageUrl);

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
            <NavLink href="/gallery" active icon="image">圖庫</NavLink>
            <LogoutButton style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(60,52,40,0.045)',
              border: '1px solid var(--border)', borderRadius: 6, padding: '8px 14px', fontSize: 13,
              fontWeight: 500, color: 'var(--text)', cursor: 'pointer' }}>
              <Icon name="logout" size={16} />登出
            </LogoutButton>
          </nav>
        </header>

        <main style={{ flex: 1, overflowY: 'auto', padding: '40px clamp(20px,5vw,64px) 64px' }}>
          <div style={{ maxWidth: 1040, margin: '0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 28, gap: 16 }} className="ax-enter">
              <div>
                <h1 style={{ fontSize: 30, margin: 0, fontWeight: 600, letterSpacing: '-0.02em' }}>圖庫</h1>
                <p style={{ fontSize: 14.5, color: 'var(--muted)', margin: '7px 0 0' }}>角色為你生成的圖片，與正在製作中的任務</p>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 7 }}>
                <Dot color="var(--accent-2)" pulse size={6} />每 5 秒自動更新
              </div>
            </div>

            {/* 任務排程 */}
            {(active.length > 0 || failed.length > 0) && (
              <div style={{ marginBottom: 36 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 12, letterSpacing: '0.02em' }}>
                  任務排程
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {active.map(t => <ScheduleRow key={t.id} task={t} onDelete={del} />)}
                  {failed.map(t => (
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
              </div>
            )}

            {/* 圖庫 */}
            {!loaded ? null : done.length === 0 && active.length === 0 && failed.length === 0 ? (
              <EmptyState icon="image" title="還沒有圖片"
                desc="在對話中告訴角色幫你畫一張圖，完成後會出現在這裡。" />
            ) : done.length > 0 ? (
              <div>
                {(active.length > 0 || failed.length > 0) && (
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 12, letterSpacing: '0.02em' }}>
                    已完成
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
                  {done.map((t, i) => (
                    <div key={t.id} style={{ animationDelay: `${i * 0.04}s` }}>
                      <GalleryCard task={t} onOpen={() => setOpen(t)} onDelete={del} />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </main>
      </div>
      {open && <Lightbox task={open} onClose={() => setOpen(null)} onDelete={del} />}
    </>
  );
}
