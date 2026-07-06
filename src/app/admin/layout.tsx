'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wordmark, Icon } from '@/app/_components/ui';
import { LogoutButton } from '@/app/_components/LogoutButton';

const ADMIN_NAV = [
  { href: '/admin',            label: '總覽',   icon: 'sparkle' },
  { href: '/admin/characters', label: '角色管理', icon: 'mask'    },
  { href: '/admin/users',      label: '用戶管理', icon: 'users'   },
  { href: '/admin/access',     label: '權限指派', icon: 'key'     },
  { href: '/admin/memories',   label: '記憶管理', icon: 'brain'   },
  { href: '/admin/podcasts',   label: 'Podcast 素材', icon: 'audio' },
  { href: '/admin/voice',      label: '即時語音', icon: 'phone' },
  { href: '/admin/global-prompts', label: '全局 Prompt', icon: 'display' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();

  return (
    <div style={{ height:'100vh', display:'grid', gridTemplateColumns:'248px 1fr', overflow:'hidden' }} className="ax-admin">
      {/* Sidebar */}
      <aside style={{ borderRight:'1px solid var(--border)', padding:'22px 16px', display:'flex', flexDirection:'column',
        background:'var(--bg-2)', overflowY:'auto' }}>
        <Link href="/admin" style={{ padding:'4px 8px 22px', display:'block', textDecoration:'none' }}><Wordmark size={18} /></Link>
        <div style={{ fontSize:11, color:'var(--muted)', letterSpacing:'0.08em', padding:'0 12px 10px', fontWeight:500 }}>管理後台</div>
        <nav style={{ display:'flex', flexDirection:'column', gap:4 }}>
          {ADMIN_NAV.map(n => {
            const active = n.href === '/admin' ? path === '/admin' : path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href}
                style={{ display:'flex', alignItems:'center', gap:11, padding:'10px 12px', borderRadius:6,
                  border:'1px solid transparent', fontSize:14, fontWeight:500, textDecoration:'none',
                  background: active ? 'color-mix(in oklab, var(--accent) 12%, transparent)' : 'transparent',
                  borderColor: active ? 'color-mix(in oklab, var(--accent) 35%, transparent)' : 'transparent',
                  color: active ? 'var(--text)' : 'var(--muted)', transition:'all .18s' }}>
                <Icon name={n.icon} size={18} style={{ color: active ? 'var(--accent)' : 'var(--muted)' }} />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div style={{ marginTop:'auto', paddingTop:16, borderTop:'1px solid var(--border)' }}>
          <Link href="/lobby"
            style={{ display:'flex', alignItems:'center', gap:9, width:'100%', padding:'9px 12px',
              borderRadius:6, border:'1px solid var(--border)', background:'transparent', color:'var(--muted)',
              fontSize:13.5, fontWeight:500, textDecoration:'none', marginBottom:8 }}>
            <svg viewBox="0 0 24 24" style={{width:16,height:16,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round',flexShrink:0}}><path d="M3 12L12 3l9 9"/><path d="M9 21V12h6v9"/><path d="M3 12v9h18v-9"/></svg>前台主頁
          </Link>
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', marginBottom:8 }}>
            <div style={{ width:34, height:34, borderRadius:6, background:'linear-gradient(155deg,#9a9389,#6f685d)',
              display:'grid', placeItems:'center', fontSize:13, fontWeight:600, color:'#fff', flexShrink:0 }}>管</div>
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:600 }}>系統管理員</div>
              <div style={{ fontSize:11.5, color:'var(--muted)' }}>admin</div>
            </div>
          </div>
          <LogoutButton style={{ display:'flex', alignItems:'center', gap:9, width:'100%', padding:'9px 12px',
            borderRadius:6, border:'1px solid var(--border)', background:'transparent', color:'var(--muted)',
            fontSize:13.5, fontWeight:500, cursor:'pointer' }}>
            <Icon name="logout" size={16} />登出
          </LogoutButton>
        </div>
      </aside>

      {/* Content */}
      <div style={{ display:'flex', flexDirection:'column', minHeight:0, overflow:'hidden' }}>
        {/* Mobile topbar */}
        <div className="ax-admin-topbar" style={{ display:'none', alignItems:'center', gap:10, padding:'12px 16px',
          borderBottom:'1px solid var(--border)', background:'var(--bg-2)', position:'sticky', top:0, zIndex:6 }}>
          <Wordmark size={17} />
          <LogoutButton style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:7, padding:'9px 13px',
            borderRadius:6, border:'1px solid var(--border)', background:'var(--panel-solid)', color:'var(--muted)',
            fontSize:13, minHeight:40, cursor:'pointer' }}>
            <Icon name="logout" size={15} />登出
          </LogoutButton>
        </div>
        {/* Mobile tabs */}
        <nav className="ax-admin-tabs" style={{ display:'none', gap:8, padding:'10px 14px', overflowX:'auto',
          borderBottom:'1px solid var(--border)', background:'var(--bg)', position:'sticky', top:56, zIndex:5 }}>
          {ADMIN_NAV.map(n => {
            const active = n.href === '/admin' ? path === '/admin' : path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href}
                style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'9px 14px', borderRadius:6,
                  whiteSpace:'nowrap', border:'1px solid', textDecoration:'none',
                  borderColor: active ? 'color-mix(in oklab, var(--accent) 35%, transparent)' : 'var(--border)',
                  background: active ? 'color-mix(in oklab, var(--accent) 12%, transparent)' : 'var(--panel-solid)',
                  color: active ? 'var(--text)' : 'var(--muted)', fontSize:13.5, fontWeight:500, minHeight:40 }}>
                <Icon name={n.icon} size={16} style={{ color: active ? 'var(--accent)' : 'var(--muted)' }} />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <main style={{ overflowY:'auto', padding:'34px clamp(20px,4vw,48px) 64px', flex:1 }}>
          {children}
        </main>
      </div>

      <style>{`
        @media (max-width: 860px) {
          .ax-admin { grid-template-columns: 1fr !important; }
          .ax-admin > aside { display: none !important; }
          .ax-admin-topbar { display: flex !important; }
          .ax-admin-tabs { display: flex !important; }
        }
      `}</style>
    </div>
  );
}
