'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wordmark, Icon, Dot, Typing, EmptyState, Ambient } from '@/app/_components/ui';
import { LogoutButton } from '@/app/_components/LogoutButton';

interface Story {
  id: string;
  intent: string;
  characterId: string;
  status: string;
  storyText: string;
  cardCount: number;
  doneCount: number;
  error: string;
  createdAt: number;
}

const PHASE: Record<string, { label: string; phase: number }> = {
  pending:   { label: '生成劇情中', phase: 1 },
  scripting: { label: '分析腳本中', phase: 2 },
  ready:     { label: '等待生圖',   phase: 3 },
  done:      { label: '完成',       phase: 3 },
  failed:    { label: '失敗',       phase: 0 },
  draft:     { label: '待開始',     phase: 0 },
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

function PhaseBar({ status, cardCount, doneCount }: { status: string; cardCount: number; doneCount: number }) {
  const info = PHASE[status] || PHASE.draft;
  const phases = [
    { label: '劇情生成', done: info.phase > 1, active: info.phase === 1 },
    { label: '腳本分析', done: info.phase > 2, active: info.phase === 2 },
    { label: `圖卡生成${cardCount > 0 ? ` ${doneCount}/${cardCount}` : ''}`, done: doneCount > 0 && doneCount === cardCount && cardCount > 0, active: info.phase === 3 && doneCount < cardCount },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, fontSize: 12 }}>
      {phases.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
          {i > 0 && <div style={{ width: 20, height: 1, background: 'var(--border)' }} />}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 5,
            background: p.done ? 'rgba(111,142,95,0.12)' : p.active ? 'rgba(194,149,78,0.12)' : 'rgba(60,52,40,0.04)',
            color: p.done ? '#6b9e7a' : p.active ? '#c2954e' : 'var(--muted)' }}>
            {p.active && <Typing />}
            {p.done && <Dot color="#6b9e7a" size={6} />}
            {!p.active && !p.done && <Dot color="rgba(255,255,255,0.2)" size={6} />}
            {p.label}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function StoriesPage() {
  const [stories, setStories] = useState<Story[]>([]);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    const r = await fetch('/api/stories').then(r => r.json()).catch(() => ({ stories: [] }));
    setStories(r.stories || []);
    setLoaded(true);
  }

  async function del(id: string, intent: string) {
    if (!confirm(`確定刪除「${intent || '這個故事'}」？此操作會刪除所有相關圖卡，無法復原。`)) return;
    setStories(prev => prev.filter(s => s.id !== id));
    await fetch(`/api/gallery/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  const anyActive = stories.some(s => s.status === 'pending' || s.status === 'scripting'
    || (s.status === 'ready' && s.doneCount < s.cardCount));

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [anyActive]);

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
            <NavLink href="/stories" active icon="image">故事板</NavLink>
            <LogoutButton style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(60,52,40,0.045)',
              border: '1px solid var(--border)', borderRadius: 6, padding: '8px 14px', fontSize: 13,
              fontWeight: 500, color: 'var(--text)', cursor: 'pointer' }}>
              <Icon name="logout" size={16} />登出
            </LogoutButton>
          </nav>
        </header>

        <main style={{ flex: 1, padding: '40px clamp(20px,5vw,64px) 64px' }}>
          <div style={{ maxWidth: 860, margin: '0 auto' }}>
            <div className="ax-enter" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 32, gap: 16 }}>
              <div>
                <h1 style={{ fontSize: 30, margin: 0, fontWeight: 600, letterSpacing: '-0.02em' }}>故事板</h1>
                <p style={{ fontSize: 14.5, color: 'var(--muted)', margin: '7px 0 0' }}>角色生成的故事圖卡 pipeline</p>
              </div>
              {anyActive && (
                <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Dot color="var(--accent-2)" pulse size={6} />每 4 秒自動更新
                </div>
              )}
            </div>

            {!loaded ? null : stories.length === 0 ? (
              <EmptyState icon="image" title="還沒有故事"
                desc="在對話中告訴角色幫你建立一個故事板，完成後會出現在這裡。" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {stories.map(s => (
                  <Link key={s.id} href={`/stories/${s.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                    <div className="ax-enter" style={{ padding: '18px 20px', borderRadius: 10, background: 'var(--panel)',
                      border: '1px solid var(--border)', cursor: 'pointer',
                      transition: 'border-color .2s, box-shadow .2s' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-strong)'; (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-hover)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{s.intent || '故事板'}</div>
                          {s.storyText && (
                            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.5,
                              overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                              {s.storyText}…
                            </div>
                          )}
                          <PhaseBar status={s.status} cardCount={s.cardCount} doneCount={s.doneCount} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{fmt(s.createdAt)}</div>
                          <button onClick={e => { e.preventDefault(); del(s.id, s.intent); }}
                            style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, borderRadius: 6,
                              background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--muted)' }}>
                            <Icon name="trash" size={15} />
                          </button>
                        </div>
                      </div>
                      {s.status === 'failed' && (
                        <div style={{ marginTop: 8, fontSize: 12, color: '#b5654a' }}>{s.error || '生成失敗'}</div>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );
}
