'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wordmark, Avatar, Icon, Tag, GlowButton, EmptyState, Ambient } from '@/app/_components/ui';
import { LogoutButton } from '@/app/_components/LogoutButton';

interface Char { id: string; name: string; avatarUrl: string; hasVoice: boolean; }

function FrontNav({ active }: { active: string }) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px clamp(16px,4vw,26px)', borderBottom: '1px solid var(--border)',
      position: 'relative', zIndex: 5, background: 'var(--bg)' }}>
      <Link href="/lobby"><Wordmark size={19} /></Link>
      <nav style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <NavLink href="/lobby" active={active === 'lobby'}>大廳</NavLink>
        <NavLink href="/documents" active={active === 'documents'} icon="doc">我的文件</NavLink>
        <NavLink href="/gallery" active={active === 'gallery'} icon="image">圖庫</NavLink>
        <LogoutButton style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(60,52,40,0.045)',
          border: '1px solid var(--border)', borderRadius: 6, padding: '8px 14px', fontSize: 13,
          fontWeight: 500, color: 'var(--text)', cursor: 'pointer' }}>
          <Icon name="logout" size={16} />登出
        </LogoutButton>
      </nav>
    </header>
  );
}

function NavLink({ children, href, active, icon }: { children: React.ReactNode; href: string; active?: boolean; icon?: string }) {
  return (
    <Link href={href} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
      background: active ? 'rgba(60,52,40,0.07)' : 'transparent',
      color: active ? 'var(--text)' : 'var(--muted)', padding: '9px 13px', borderRadius: 6,
      fontSize: 14, fontWeight: 500, minHeight: 40 }}>
      {icon && <Icon name={icon} size={16} />}{children}
    </Link>
  );
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
              <div style={{ fontSize: 13, color: 'var(--accent-2)', fontWeight: 500, letterSpacing: '0.08em', marginBottom: 8 }}>你的角色空間</div>
              <h1 style={{ fontSize: 32, margin: '0 0 8px', fontWeight: 600, letterSpacing: '-0.02em' }}>選擇一位角色，開始對話</h1>
              <p style={{ fontSize: 15, color: 'var(--muted)', margin: 0 }}>他們都記得你 — 繼續未完的對話，或開啟新的話題。</p>
            </div>

            {!loaded ? null : chars.length === 0 ? (
              <EmptyState icon="mask" title="還沒有被指派任何角色"
                desc="你的帳號目前尚未取得任何角色的存取權限。請聯絡管理者為你開通。" />
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
        <Avatar name={char.name} avatarUrl={char.avatarUrl} size={66} ring={h} />
        {char.hasVoice && (
          <Tag color="var(--accent-2)"><Icon name="mic" size={12} />可語音</Tag>
        )}
      </div>
      <h3 style={{ fontSize: 21, margin: '0 0 4px', fontWeight: 600 }}>{char.name}</h3>
      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 500,
        color: h ? 'var(--accent)' : 'var(--muted)', transition: 'color .25s' }}>
        進入對話 <Icon name="chevron" size={15} style={{ transform: h ? 'translateX(3px)' : 'none', transition: 'transform .25s' }} />
      </div>
    </Link>
  );
}
