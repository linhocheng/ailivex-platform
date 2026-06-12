'use client';

import { useEffect, useState, useCallback } from 'react';
import { Icon, Avatar, Dot, Field } from '@/app/_components/ui';

interface User { id: string; username: string; displayName: string; role: string; }
interface Char { id: string; name: string; avatarUrl: string; hasVoice: boolean; }

const inputStyle: React.CSSProperties = {
  background:'var(--panel-2)', border:'1px solid var(--border)', borderRadius:8,
  padding:'10px 12px', color:'var(--text)', fontSize:14, outline:'none', width:'100%',
  appearance:'none', cursor:'pointer',
};

export default function AdminAccess() {
  const [users, setUsers] = useState<User[]>([]);
  const [chars, setChars] = useState<Char[]>([]);
  const [selUser, setSelUser] = useState('');
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch('/api/admin/users').then(r => r.json()).then(r => setUsers(r.users || [])).catch(() => {});
    fetch('/api/admin/characters').then(r => r.json()).then(r => setChars(r.characters || [])).catch(() => {});
  }, []);

  const loadAccess = useCallback(async (userId: string) => {
    if (!userId) { setGranted(new Set()); return; }
    const r = await fetch(`/api/admin/access?userId=${encodeURIComponent(userId)}`).then(r => r.json()).catch(() => ({ access:[] }));
    setGranted(new Set((r.access || []).map((a: { characterId: string }) => a.characterId)));
  }, []);

  useEffect(() => { loadAccess(selUser); }, [selUser, loadAccess]);

  async function toggle(characterId: string) {
    if (!selUser) return;
    setMsg('');
    const on = granted.has(characterId);
    const r = await fetch('/api/admin/access', {
      method: on ? 'DELETE' : 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ userId: selUser, characterId }),
    }).then(r => r.json()).catch(() => null);
    if (r?.ok) {
      const next = new Set(granted);
      if (on) next.delete(characterId); else next.add(characterId);
      setGranted(next);
    } else setMsg('操作失敗');
  }

  const userList = users.filter(u => u.role === 'user');
  const allOn = chars.length > 0 && chars.every(c => granted.has(c.id));
  const toggleAll = async () => {
    for (const c of chars) {
      const on = granted.has(c.id);
      if (allOn ? on : !on) await toggle(c.id);
    }
  };

  return (
    <div>
      <div className="ax-enter" style={{ marginBottom:28 }}>
        <h1 style={{ fontSize:27, margin:0, fontWeight:600, letterSpacing:'-0.02em' }}>權限指派</h1>
        <p style={{ fontSize:14, color:'var(--muted)', margin:'7px 0 0' }}>控制每個用戶能看到哪些角色 — 變更即時生效。</p>
      </div>

      <div style={{ maxWidth:720 }} className="ax-enter">
        <div style={{ background:'var(--panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:24 }}>
          <Field label="選擇用戶">
            <div style={{ position:'relative' }}>
              <select value={selUser} onChange={e => setSelUser(e.target.value)} style={inputStyle}>
                <option value="">— 選擇用戶 —</option>
                {userList.map(u => <option key={u.id} value={u.id}>{u.displayName}（{u.username}）</option>)}
              </select>
              <Icon name="chevron" size={16} style={{ position:'absolute', right:12, top:'50%', transform:'translateY(-50%) rotate(90deg)', color:'var(--muted)', pointerEvents:'none' }} />
            </div>
          </Field>

          {selUser && (
            <>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', margin:'24px 0 14px' }}>
                <span style={{ fontSize:13.5, fontWeight:500 }}>
                  角色存取權 <span style={{ color:'var(--muted)', fontWeight:400 }}>· 已勾選 {granted.size} / {chars.length}</span>
                </span>
                <button onClick={toggleAll} style={{ fontSize:13, color:'var(--accent)', background:'none', border:'none', fontWeight:500, cursor:'pointer' }}>
                  {allOn ? '取消全選' : '全選'}
                </button>
              </div>

              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {chars.map(c => {
                  const on = granted.has(c.id);
                  return (
                    <button key={c.id} onClick={() => toggle(c.id)}
                      style={{ display:'flex', alignItems:'center', gap:14, padding:'11px 14px', borderRadius:7, textAlign:'left',
                        border:'1px solid', width:'100%', cursor:'pointer', transition:'all .18s',
                        borderColor: on ? 'color-mix(in oklab, var(--accent) 45%, var(--border))' : 'var(--border)',
                        background: on ? 'color-mix(in oklab, var(--accent) 8%, transparent)' : 'rgba(60,52,40,0.02)' }}>
                      <Avatar name={c.name} avatarUrl={c.avatarUrl} size={40} ring={on} />
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:14.5, fontWeight:600 }}>{c.name}</div>
                        <div style={{ fontSize:12.5, color:'var(--muted)' }}>
                          {c.hasVoice ? '可語音' : '文字'}
                        </div>
                      </div>
                      <div style={{ width:26, height:26, borderRadius:8, display:'grid', placeItems:'center', flexShrink:0,
                        border:'1px solid', borderColor: on ? 'var(--accent)' : 'var(--border-strong)',
                        background: on ? 'var(--accent)' : 'transparent', transition:'all .18s', color:'#fff' }}>
                        {on && <Icon name="check" size={15} />}
                      </div>
                    </button>
                  );
                })}
                {chars.length === 0 && <div style={{ fontSize:14, color:'var(--muted)', padding:'12px 0' }}>還沒有角色，先去建立。</div>}
              </div>
            </>
          )}

          {msg && (
            <div style={{ marginTop:14, fontSize:13, color:'#b5654a', display:'flex', alignItems:'center', gap:7 }}>
              <Dot color="#b5654a" />{msg}
            </div>
          )}
          {selUser && (
            <div style={{ fontSize:12.5, color:'var(--muted)', marginTop:16, display:'flex', alignItems:'center', gap:7 }}>
              <Dot color="#6f8c5f" pulse size={6} />勾選即新增、取消即移除，變更已即時儲存。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
