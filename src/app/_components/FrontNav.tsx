'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wordmark, Icon } from '@/app/_components/ui';
import { LogoutButton } from '@/app/_components/LogoutButton';

/**
 * 用戶端共用導航 — 唯一真相源。
 * 桌面：頂部導航列。手機（<768px）：底部 tab bar（拇指舒適區），
 * 主要三項 + 「更多」bottom sheet 收其餘項目與登出。
 * 新增前台頁面時在 NAV_ITEMS 加一條，desktop/mobile 同步生效。
 */
const NAV_ITEMS = [
  { key: 'lobby',     href: '/lobby',     label: '大廳',      icon: 'mask' },
  { key: 'documents', href: '/documents', label: '我的文件',  icon: 'doc' },
  { key: 'gallery',   href: '/gallery',   label: '媒體庫',    icon: 'image' },
  { key: 'stories',   href: '/stories',   label: '故事板',    icon: 'image' },
  { key: 'convert',   href: '/convert',   label: '語音製作', icon: 'audio' },
  { key: 'podcasts',  href: '/podcasts',  label: 'Podcast 製作', icon: 'audio' },
];

// 手機底部 tab：前三項直出，其餘收進「更多」
const MOBILE_PRIMARY = NAV_ITEMS.slice(0, 3);
const MOBILE_MORE = NAV_ITEMS.slice(3);

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

function BottomTab({ href, label, icon, active, onClick }: {
  href?: string; label: string; icon: string; active?: boolean; onClick?: () => void;
}) {
  const inner = (
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
      color: active ? 'var(--accent)' : 'var(--muted)', fontSize: 10.5, fontWeight: 500,
      padding: '8px 0 6px', minHeight: 52, justifyContent: 'center', width: '100%' }}>
      <Icon name={icon} size={21} />
      {label}
    </span>
  );
  if (href) return <Link href={href} style={{ flex: 1, textDecoration: 'none' }}>{inner}</Link>;
  return <button onClick={onClick} style={{ flex: 1, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{inner}</button>;
}

export function FrontNav({ active }: { active: string }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(r => setIsAdmin(r.role === 'admin')).catch(() => {});
  }, []);

  const moreActive = MOBILE_MORE.some(i => i.key === active);

  return (
    <>
      {/* 桌面頂部導航 */}
      <header className="ax-front-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px clamp(16px,4vw,26px)', borderBottom: '1px solid var(--border)',
        position: 'relative', zIndex: 5, background: 'var(--bg)', gap: 8 }}>
        <Link href="/lobby"><Wordmark size={19} /></Link>
        <nav className="ax-front-nav-desktop" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {NAV_ITEMS.map(item => (
            <NavLink key={item.key} href={item.href} active={active === item.key} icon={item.icon}>
              {item.label}
            </NavLink>
          ))}
          {isAdmin && (
            <Link href="/admin" style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
              color: 'var(--accent)', padding: '9px 13px', borderRadius: 6, fontSize: 14, fontWeight: 500,
              minHeight: 40, border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)' }}>
              <Icon name="key" size={15} />管理後台
            </Link>
          )}
          <LogoutButton style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(60,52,40,0.045)',
            border: '1px solid var(--border)', borderRadius: 6, padding: '8px 14px', fontSize: 13,
            fontWeight: 500, color: 'var(--text)', cursor: 'pointer' }}>
            <Icon name="logout" size={16} />登出
          </LogoutButton>
        </nav>
      </header>

      {/* 手機底部 tab bar */}
      <nav className="ax-front-bottomnav" style={{ display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0,
        zIndex: 40, background: 'color-mix(in oklab, var(--bg) 88%, transparent)', backdropFilter: 'blur(14px)',
        borderTop: '1px solid var(--border)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          {MOBILE_PRIMARY.map(item => (
            <BottomTab key={item.key} href={item.href} label={item.label} icon={item.icon} active={active === item.key} />
          ))}
          <BottomTab label="更多" icon="menu" active={moreActive || moreOpen} onClick={() => setMoreOpen(v => !v)} />
        </div>
      </nav>

      {/* 更多 bottom sheet */}
      {moreOpen && (
        <>
          <div onClick={() => setMoreOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 41, background: 'rgba(20,16,10,0.35)' }} />
          <div className="ax-enter" style={{ position: 'fixed', left: 10, right: 10,
            bottom: 'calc(64px + env(safe-area-inset-bottom, 0px))', zIndex: 42,
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14,
            boxShadow: '0 -8px 40px -12px rgba(0,0,0,0.25)', overflow: 'hidden' }}>
            {MOBILE_MORE.map(item => (
              <Link key={item.key} href={item.href} onClick={() => setMoreOpen(false)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 20px', minHeight: 48,
                  borderBottom: '1px solid var(--border)', textDecoration: 'none', fontSize: 15, fontWeight: 500,
                  color: active === item.key ? 'var(--accent)' : 'var(--text)' }}>
                <Icon name={item.icon} size={18} />{item.label}
              </Link>
            ))}
            {isAdmin && (
              <Link href="/admin" onClick={() => setMoreOpen(false)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 20px', minHeight: 48,
                  borderBottom: '1px solid var(--border)', textDecoration: 'none', fontSize: 15, fontWeight: 500,
                  color: 'var(--accent)' }}>
                <Icon name="key" size={18} />管理後台
              </Link>
            )}
            <LogoutButton style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 20px', minHeight: 48,
              width: '100%', background: 'none', border: 'none', fontSize: 15, fontWeight: 500,
              color: 'var(--muted)', cursor: 'pointer', textAlign: 'left' }}>
              <Icon name="logout" size={18} />登出
            </LogoutButton>
          </div>
        </>
      )}

      {/* 響應式切換 + 手機底部留白（防 tab bar 蓋內容） */}
      <style>{`
        @media (max-width: 767px) {
          .ax-front-nav-desktop { display: none !important; }
          .ax-front-bottomnav { display: block !important; }
          main { padding-bottom: 104px !important; }
        }
      `}</style>
    </>
  );
}
