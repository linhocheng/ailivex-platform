'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wordmark, Icon } from '@/app/_components/ui';
import { LogoutButton } from '@/app/_components/LogoutButton';

/**
 * 用戶端共用導航列 — 唯一真相源。
 * 新增前台頁面時在 NAV_ITEMS 加一條，所有頁面同步生效。
 */
const NAV_ITEMS = [
  { key: 'lobby',     href: '/lobby',     label: '大廳',      icon: undefined as string | undefined },
  { key: 'documents', href: '/documents', label: '我的文件',  icon: 'doc' },
  { key: 'gallery',   href: '/gallery',   label: '媒體庫',    icon: 'image' },
  { key: 'stories',   href: '/stories',   label: '故事板',    icon: 'image' },
  { key: 'convert',   href: '/convert',   label: '素材轉換區', icon: 'audio' },
  { key: 'podcasts',  href: '/podcasts',  label: 'Podcast 素材', icon: 'audio' },
];

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

export function FrontNav({ active }: { active: string }) {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(r => setIsAdmin(r.role === 'admin')).catch(() => {});
  }, []);

  return (
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px clamp(16px,4vw,26px)', borderBottom: '1px solid var(--border)',
      position: 'relative', zIndex: 5, background: 'var(--bg)', flexWrap: 'wrap', gap: 8 }}>
      <Link href="/lobby"><Wordmark size={19} /></Link>
      <nav style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
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
  );
}
