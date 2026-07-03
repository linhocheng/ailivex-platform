'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Avatar, Icon, Tag, GlowButton, EmptyState, Ambient } from '@/app/_components/ui';
import { FrontNav } from '@/app/_components/FrontNav';

interface Char { id: string; name: string; avatarUrl: string; hasVoice: boolean;
  lastTopic?: string; lastAt?: number | null; }

// 相對時間（今天/昨天/N天前/日期）
function relTime(at: number): string {
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days <= 7) return `${days} 天前`;
  return new Date(at).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' });
}

export default function Lobby() {
  const [chars, setChars] = useState<Char[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/characters').then(r => r.json())
      .then(r => { setChars(r.characters || []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  return (
    <>
      <Ambient />
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
        <FrontNav active="lobby" />
        <main style={{ flex: 1, overflowY: 'auto', padding: '44px clamp(20px,5vw,64px) 64px' }}>
          <div style={{ maxWidth: 1100, margin: '0 auto' }}>
            <div style={{ marginBottom: 34 }} className="ax-enter">
              <div style={{ fontSize: 13, color: 'var(--accent-2)', fontWeight: 500, letterSpacing: '0.08em', marginBottom: 8 }}>您的角色空間</div>
              <h1 style={{ fontSize: 32, margin: '0 0 8px', fontWeight: 600, letterSpacing: '-0.02em' }}>選擇一位角色，接續對話</h1>
              <p style={{ fontSize: 15, color: 'var(--muted)', margin: 0 }}>每位角色都記得與您的每一次交流——接續未完的討論，或展開新的主題。</p>
            </div>

            {!loaded ? null : chars.length === 0 ? (
              <EmptyState icon="mask" title="尚未開通角色"
                desc="您的帳號尚未開通任何角色，請聯繫您的服務窗口。" />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: 18 }}>
                {chars.map((c, i) => <CharCard key={c.id} char={c} delay={i * 0.05} />)}
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );
}

function CharCard({ char, delay }: { char: Char; delay: number }) {
  const [h, setH] = useState(false);
  return (
    <Link href={`/chat/${char.id}`}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      className="ax-enter"
      style={{ animationDelay: `${delay}s`, display: 'block', cursor: 'pointer',
        borderRadius: 'var(--radius)', padding: 22, overflow: 'hidden', textDecoration: 'none',
        background: 'var(--panel)', border: '1px solid var(--border)',
        boxShadow: h ? 'var(--shadow-hover)' : 'var(--shadow)',
        transform: h ? 'translateY(-4px)' : 'none',
        transition: 'transform .3s cubic-bezier(.2,.8,.2,1), box-shadow .3s, border-color .3s',
        borderColor: h ? 'var(--border-strong)' : 'var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
        <Avatar name={char.name} avatarUrl={char.avatarUrl} size={84} ring={h} />
        {char.hasVoice && (
          <Tag color="var(--accent-2)"><Icon name="mic" size={12} />可語音</Tag>
        )}
      </div>
      <h3 style={{ fontSize: 21, margin: '0 0 6px', fontWeight: 600 }}>{char.name}</h3>
      {char.lastTopic ? (
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0, lineHeight: 1.6,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }}>
          {char.lastAt ? `${relTime(char.lastAt)}聊到：` : '上次聊到：'}{char.lastTopic}
        </p>
      ) : (
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0, opacity: 0.7 }}>還沒開始過對話</p>
      )}
      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 500,
        color: h ? 'var(--accent)' : 'var(--muted)', transition: 'color .25s' }}>
        {char.lastTopic ? '接續對話' : '開始對話'} <Icon name="chevron" size={15} style={{ transform: h ? 'translateX(3px)' : 'none', transition: 'transform .25s' }} />
      </div>
    </Link>
  );
}
