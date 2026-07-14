'use client';

import { useEffect, useState, useCallback } from 'react';
import { Icon, Dot, Tag, GlowButton } from '@/app/_components/ui';

interface MemoryItem {
  id: string; userId: string; characterId: string; content: string;
  tier: string; type?: string | null; status?: string | null;
  importance: number; hitCount: number; source: string;
  lastHitAt: number | null; createdAt: number | null;
}
interface UserItem { id: string; username: string; displayName: string; }
interface CharItem { id: string; name: string; }
interface CharStat { total: number; core: number; fresh: number; archive: number; noStatus: number; }

const TIER: Record<string, { label: string; color: string; dot: string }> = {
  core:    { label:'核心', color:'#6f8c5f', dot:'#6f8c5f' },
  fresh:   { label:'新鮮', color:'#60a5fa', dot:'#60a5fa' },
  archive: { label:'封存', color:'var(--muted)', dot:'rgba(60,52,40,0.3)' },
};

const STATUS: Record<string, { label: string; color: string }> = {
  active:   { label:'活躍', color:'#6f8c5f' },
  stale:    { label:'過期', color:'#b08a3e' },
  resolved: { label:'已解決', color:'var(--muted)' },
};

const selStyle: React.CSSProperties = {
  background:'var(--panel-2)', border:'1px solid var(--border)', borderRadius:8,
  padding:'8px 10px', color:'var(--text)', fontSize:14, outline:'none', cursor:'pointer',
};

function fmt(ms: number | null) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('zh-TW', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

export default function AdminMemories() {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [chars, setChars] = useState<CharItem[]>([]);
  const [filterUser, setFilterUser] = useState('');
  const [filterChar, setFilterChar] = useState('');
  const [filterTier, setFilterTier] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [stats, setStats] = useState<Record<string, CharStat>>({});
  const [list, setList] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promoteResult, setPromoteResult] = useState('');

  useEffect(() => {
    fetch('/api/admin/users').then(r => r.json()).then(d => setUsers(d.users || []));
    fetch('/api/admin/characters').then(r => r.json()).then(d => setChars((d.characters || []).map((c: CharItem) => ({ id:c.id, name:c.name }))));
    fetch('/api/admin/memories/stats').then(r => r.json()).then(d => setStats(d.byChar || {}));
    // /admin/memories?characterId=xxx 直達預篩（characters 頁「記憶」連結進來）
    const cid = new URLSearchParams(window.location.search).get('characterId');
    if (cid) setFilterChar(cid);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams();
    if (filterUser) p.set('userId', filterUser);
    if (filterChar) p.set('characterId', filterChar);
    if (filterTier) p.set('tier', filterTier);
    const r = await fetch(`/api/admin/memories?${p}`).then(r => r.json()).catch(() => ({ memories:[] }));
    // status 在 JS 端過濾（避免 composite index；「無」= 缺 status 的舊資料）
    const all: MemoryItem[] = r.memories || [];
    setList(filterStatus === '' ? all
      : filterStatus === 'none' ? all.filter(m => !m.status)
      : all.filter(m => m.status === filterStatus));
    setLoading(false);
  }, [filterUser, filterChar, filterTier, filterStatus]);

  useEffect(() => { load(); }, [load]);

  async function changeTier(id: string, tier: string) {
    await fetch(`/api/admin/memories/${id}`, {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ tier }),
    });
    setList(prev => prev.map(m => m.id === id ? { ...m, tier } : m));
  }

  async function changeStatus(id: string, status: string) {
    await fetch(`/api/admin/memories/${id}`, {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ status }),
    });
    setList(prev => prev.map(m => m.id === id ? { ...m, status } : m));
  }

  async function deleteMemory(id: string) {
    if (!confirm('確定刪除這筆記憶？')) return;
    await fetch(`/api/admin/memories/${id}`, { method:'DELETE' });
    setList(prev => prev.filter(m => m.id !== id));
  }

  async function runPromote() {
    setPromoting(true); setPromoteResult('');
    const r = await fetch('/api/admin/memories/promote', { method:'POST' }).then(r => r.json()).catch(() => null);
    setPromoting(false);
    if (r) {
      setPromoteResult(`晉升 ${r.promoted} 筆 → core，封存 ${r.archived} 筆 → archive`);
      load();
    }
  }

  const userName = (id: string) => users.find(u => u.id === id)?.displayName || id.slice(0, 8);
  const charName = (id: string) => chars.find(c => c.id === id)?.name || id.slice(0, 8);

  return (
    <div>
      <div className="ax-enter" style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', gap:16, marginBottom:28 }}>
        <div>
          <h1 style={{ fontSize:27, margin:0, fontWeight:600, letterSpacing:'-0.02em' }}>記憶管理</h1>
          <p style={{ fontSize:14, color:'var(--muted)', margin:'7px 0 0' }}>查看、調層、刪除各用戶×角色的記憶，執行 Tier 晉升。</p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
          {promoteResult && <span style={{ fontSize:13, color:'var(--muted)' }}>{promoteResult}</span>}
          <GlowButton onClick={runPromote} disabled={promoting}>
            <Icon name="sparkle" size={15} />{promoting ? '晉升中…' : '執行 Tier 晉升'}
          </GlowButton>
        </div>
      </div>

      {/* 角色統計卡：點卡片＝帶入該角色篩選 */}
      <div style={{ display:'flex', gap:8, marginBottom:18, flexWrap:'wrap' }} className="ax-enter">
        {chars
          .filter(c => stats[c.id]?.total)
          .sort((a, b) => (stats[b.id]?.total ?? 0) - (stats[a.id]?.total ?? 0))
          .map(c => {
            const s = stats[c.id];
            const selected = filterChar === c.id;
            return (
              <button key={c.id} onClick={() => setFilterChar(selected ? '' : c.id)}
                style={{ background: selected ? 'color-mix(in oklab, var(--accent) 10%, var(--panel))' : 'var(--panel)',
                  border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, borderRadius:8,
                  padding:'10px 14px', cursor:'pointer', textAlign:'left', color:'var(--text)' }}>
                <div style={{ fontSize:13, fontWeight:600 }}>{c.name} <span style={{ fontWeight:400, color:'var(--muted)' }}>{s.total}</span></div>
                <div style={{ fontSize:11, color:'var(--muted)', marginTop:3, display:'flex', gap:8 }}>
                  <span style={{ color:'#6f8c5f' }}>核 {s.core}</span>
                  <span style={{ color:'#60a5fa' }}>鮮 {s.fresh}</span>
                  <span>封 {s.archive}</span>
                  {s.noStatus > 0 && <span style={{ color:'#b08a3e' }}>無狀態 {s.noStatus}</span>}
                </div>
              </button>
            );
          })}
      </div>

      {/* Filters */}
      <div style={{ display:'flex', gap:10, marginBottom:18, flexWrap:'wrap', alignItems:'center' }} className="ax-enter">
        <select style={selStyle} value={filterUser} onChange={e => setFilterUser(e.target.value)}>
          <option value="">所有用戶</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.displayName} ({u.username})</option>)}
        </select>
        <select style={selStyle} value={filterChar} onChange={e => setFilterChar(e.target.value)}>
          <option value="">所有角色</option>
          {chars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={selStyle} value={filterTier} onChange={e => setFilterTier(e.target.value)}>
          <option value="">所有層級</option>
          <option value="core">核心 (core)</option>
          <option value="fresh">新鮮 (fresh)</option>
          <option value="archive">封存 (archive)</option>
        </select>
        <select style={selStyle} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">所有狀態</option>
          <option value="active">活躍 (active)</option>
          <option value="stale">過期 (stale)</option>
          <option value="resolved">已解決 (resolved)</option>
          <option value="none">無狀態（舊資料）</option>
        </select>
        <span style={{ fontSize:13, color:'var(--muted)', marginLeft:4 }}>
          {loading ? '載入中…' : `${list.length} 筆`}
        </span>
      </div>

      {/* List */}
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        {list.map(m => {
          const t = TIER[m.tier] || TIER.fresh;
          return (
            <div key={m.id} style={{ background:'var(--panel)', border:'1px solid var(--border)', borderRadius:8, padding:'14px 18px' }}
              className="ax-enter">
              <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
                <Tag color={t.color}><Dot color={t.dot} size={6} />{t.label}</Tag>
                {m.type && <Tag color="var(--muted)">{m.type}</Tag>}
                {m.status ? <Tag color={STATUS[m.status]?.color ?? 'var(--muted)'}>{STATUS[m.status]?.label ?? m.status}</Tag>
                  : <Tag color="#b08a3e">無狀態</Tag>}
                <div style={{ flex:1, fontSize:14, lineHeight:1.6 }}>{m.content}</div>
                <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                  <select style={{ ...selStyle, padding:'4px 8px', fontSize:12 }}
                    value={m.tier} onChange={e => changeTier(m.id, e.target.value)}>
                    <option value="fresh">新鮮</option>
                    <option value="core">核心</option>
                    <option value="archive">封存</option>
                  </select>
                  <select style={{ ...selStyle, padding:'4px 8px', fontSize:12 }}
                    value={m.status ?? ''} onChange={e => changeStatus(m.id, e.target.value)}>
                    {!m.status && <option value="" disabled>無狀態</option>}
                    <option value="active">活躍</option>
                    <option value="stale">過期</option>
                    <option value="resolved">已解決</option>
                  </select>
                  <button onClick={() => deleteMemory(m.id)}
                    style={{ width:32, height:32, borderRadius:6, border:'1px solid var(--border)', background:'transparent',
                      color:'var(--muted)', display:'grid', placeItems:'center', cursor:'pointer', transition:'color .2s' }}
                    onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color='#b5654a'}
                    onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color='var(--muted)'}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
              <div style={{ display:'flex', gap:14, fontSize:11.5, color:'var(--muted)', marginTop:8, flexWrap:'wrap' }}>
                <span>{userName(m.userId)} × {charName(m.characterId)}</span>
                <span>重要度 {m.importance}</span>
                <span>召喚 {m.hitCount} 次</span>
                <span>來源 {m.source}</span>
                <span>最後召喚 {fmt(m.lastHitAt)}</span>
                <span>建立 {fmt(m.createdAt)}</span>
              </div>
            </div>
          );
        })}
        {!loading && list.length === 0 && (
          <div style={{ padding:48, textAlign:'center', fontSize:14, color:'var(--muted)' }}>暫無記憶</div>
        )}
      </div>
    </div>
  );
}
