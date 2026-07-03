'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/app/_components/ui';

interface Stats { characters: number; users: number; access: number; memories: number; }
interface Overview { users: number; characters: number; access: number; documents: number;
  voiceMinutesTotal: number; quotaAlerts: number; }

const CARDS = [
  { href:'/admin/characters', icon:'mask',   title:'角色', desc:'建立角色（靈魂 + 頭像）', statKey:'characters' as const, unit:'個角色', accent:'var(--accent)' },
  { href:'/admin/users',      icon:'users',  title:'用戶', desc:'開帳號給用戶',             statKey:'users'      as const, unit:'位用戶', accent:'var(--accent-2)' },
  { href:'/admin/access',     icon:'key',    title:'指派', desc:'決定誰能跟哪些角色聊',     statKey:'access'     as const, unit:'組授權', accent:'#7f9068' },
  { href:'/admin/memories',   icon:'brain',  title:'記憶', desc:'查看 / 調層 / 刪除記憶',  statKey:'memories'   as const, unit:'筆記憶', accent:'#9b8aa3' },
];

export default function AdminHome() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats>({ characters:0, users:0, access:0, memories:0 });
  const [ov, setOv] = useState<Overview | null>(null);

  useEffect(() => {
    fetch('/api/admin/overview').then(r => r.json())
      .then((o: Overview) => {
        setOv(o);
        setStats(s => ({ ...s, characters: o.characters, users: o.users, access: o.access }));
      }).catch(() => {});
    fetch('/api/admin/memories?limit=1').then(r => r.json())
      .then(mems => setStats(s => ({ ...s, memories: mems.total || 0 }))).catch(() => {});
  }, []);

  return (
    <div>
      <div style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', gap:16, marginBottom:28 }} className="ax-enter">
        <div>
          <h1 style={{ fontSize:27, margin:0, fontWeight:600, letterSpacing:'-0.02em' }}>後台總覽</h1>
          <p style={{ fontSize:14, color:'var(--muted)', margin:'7px 0 0' }}>管理角色、用戶、權限與記憶 — 從這裡進入每個功能。</p>
        </div>
      </div>

      {/* 健康度摘要列：回答「一切正常嗎」。額度告警 > 0 時亮紅、點了直達用戶管理 */}
      {ov && (
        <div className="ax-enter" style={{ display:'flex', gap:12, flexWrap:'wrap', marginBottom:22 }}>
          <HealthChip label="用戶" value={String(ov.users)} />
          <HealthChip label="上線角色" value={String(ov.characters)} />
          <HealthChip label="指派" value={String(ov.access)} />
          <HealthChip label="文件產出" value={String(ov.documents)} />
          <HealthChip label="語音累計" value={`${ov.voiceMinutesTotal} 分鐘`} />
          <HealthChip label="額度告警" value={String(ov.quotaAlerts)} alert={ov.quotaAlerts > 0}
            onClick={ov.quotaAlerts > 0 ? () => router.push('/admin/users') : undefined} />
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(240px,1fr))', gap:16 }}>
        {CARDS.map((c, i) => (
          <StatCard key={c.href} card={c} stat={stats[c.statKey]} delay={i*0.05} onClick={() => router.push(c.href)} />
        ))}
      </div>
    </div>
  );
}

function StatCard({ card, stat, delay, onClick }: {
  card: typeof CARDS[0]; stat: number; delay: number; onClick: () => void;
}) {
  const [h, setH] = useState(false);
  return (
    <div onClick={onClick} className="ax-enter"
      style={{ animationDelay:`${delay}s`, cursor:'pointer', position:'relative', overflow:'hidden',
        padding:24, borderRadius:'var(--radius)', background:'var(--panel)',
        border:'1px solid', borderColor: h ? `color-mix(in oklab, ${card.accent} 45%, var(--border))` : 'var(--border)',
        transform: h ? 'translateY(-4px)' : 'none', transition:'transform .25s, border-color .25s' }}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}>
      <div style={{ position:'absolute', inset:0, opacity:0.14, pointerEvents:'none',
        background:`radial-gradient(120% 80% at 90% -10%, color-mix(in oklab, ${card.accent} 26%, transparent), transparent 55%)` }} />
      <div style={{ position:'relative' }}>
        <div style={{ width:48, height:48, borderRadius:8, display:'grid', placeItems:'center', marginBottom:18,
          background:`color-mix(in oklab, ${card.accent} 18%, transparent)`, color:card.accent,
          border:`1px solid color-mix(in oklab, ${card.accent} 30%, transparent)` }}>
          <Icon name={card.icon} size={24} />
        </div>
        <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:6 }}>
          <h3 style={{ fontSize:19, margin:0, fontWeight:600 }}>{card.title}</h3>
          <span style={{ fontSize:13, color:card.accent, fontVariantNumeric:'tabular-nums' }}>{stat} {card.unit}</span>
        </div>
        <p style={{ fontSize:13.5, color:'var(--muted)', margin:0, lineHeight:1.6 }}>{card.desc}</p>
        <div style={{ marginTop:16, fontSize:13, color:card.accent, display:'flex', alignItems:'center', gap:6, fontWeight:500 }}>
          進入 <Icon name="chevron" size={14} style={{ transform: h ? 'translateX(3px)' : 'none', transition:'transform .25s' }} />
        </div>
      </div>
    </div>
  );
}


function HealthChip({ label, value, alert, onClick }: {
  label: string; value: string; alert?: boolean; onClick?: () => void;
}) {
  return (
    <div onClick={onClick}
      style={{ display:'flex', alignItems:'baseline', gap:8, padding:'12px 18px', borderRadius:10, minHeight:44,
        background: alert ? 'rgba(181,101,74,0.09)' : 'var(--panel)',
        border: `1px solid ${alert ? 'rgba(181,101,74,0.4)' : 'var(--border)'}`,
        cursor: onClick ? 'pointer' : 'default' }}>
      <span style={{ fontSize:12, color: alert ? '#b5654a' : 'var(--muted)', fontWeight:500 }}>{label}</span>
      <span style={{ fontSize:19, fontWeight:650, letterSpacing:'-0.01em',
        color: alert ? '#b5654a' : 'var(--text)', fontVariantNumeric:'tabular-nums' }}>{value}</span>
      {alert && <span style={{ fontSize:11.5, color:'#b5654a' }}>需處理</span>}
    </div>
  );
}