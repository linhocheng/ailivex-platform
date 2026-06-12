'use client';

import { useEffect, useState } from 'react';
import { Icon, Dot, Tag, Field, TextInput, GlowButton } from '@/app/_components/ui';

interface User { id: string; username: string; displayName: string; role: string; }

export default function AdminUsers() {
  const [list, setList] = useState<User[]>([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const r = await fetch('/api/admin/users').then(r => r.json()).catch(() => ({ users: [] }));
    setList(r.users || []);
  }
  useEffect(() => { load(); }, []);

  async function create(e?: React.FormEvent) {
    e?.preventDefault();
    if (!username.trim() || password.length < 6) {
      setMsg({ ok:false, text: password.length < 6 ? '密碼至少需 6 碼' : '請填寫所有欄位' }); return;
    }
    setMsg(null); setBusy(true);
    const r = await fetch('/api/admin/users', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username, displayName, password }),
    }).then(r => r.json()).catch(() => null);
    setBusy(false);
    if (r?.id) {
      setUsername(''); setDisplayName(''); setPassword('');
      setMsg({ ok:true, text:`已建立帳號「${displayName || username}」` });
      setTimeout(() => setMsg(null), 2600);
      load();
    } else setMsg({ ok:false, text: r?.error || '建立失敗' });
  }

  return (
    <div>
      <div className="ax-enter" style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', gap:16, marginBottom:28 }}>
        <div>
          <h1 style={{ fontSize:27, margin:0, fontWeight:600, letterSpacing:'-0.02em' }}>用戶管理</h1>
          <p style={{ fontSize:14, color:'var(--muted)', margin:'7px 0 0' }}>建立用戶帳號，供用戶登入前台。</p>
        </div>
      </div>

      {/* Create form */}
      <div style={{ background:'var(--panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)',
        padding:24, marginBottom:22 }} className="ax-enter">
        <div style={{ fontSize:14.5, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
          <Icon name="plus" size={17} style={{ color:'var(--accent)' }} />新增用戶
        </div>
        <form onSubmit={create} style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr auto', gap:14, alignItems:'end' }} className="ax-user-form">
          <Field label="帳號"><TextInput value={username} onChange={e => setUsername(e.target.value)} placeholder="username" autoComplete="off" /></Field>
          <Field label="顯示名稱"><TextInput value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="顯示名稱" /></Field>
          <Field label="密碼"><TextInput type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="≥ 6 碼" /></Field>
          <GlowButton type="submit" onClick={create} disabled={busy} style={{ height:44 }}>建立</GlowButton>
        </form>
        <div style={{ fontSize:12, color:'var(--muted)', marginTop:12, display:'flex', alignItems:'center', gap:8 }}>
          <Icon name="key" size={13} />密碼以明文輸入，後端由 scrypt 加密儲存。
          {msg && (
            <span className="ax-enter" style={{ marginLeft:'auto', color: msg.ok ? '#6f8c5f' : '#b5654a', display:'flex', alignItems:'center', gap:6 }}>
              <Dot color={msg.ok ? '#6f8c5f' : '#b5654a'} />{msg.text}
            </span>
          )}
        </div>
      </div>

      {/* List */}
      <div style={{ background:'var(--panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }} className="ax-enter">
        {/* Header */}
        <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr 0.7fr', gap:12, padding:'12px 20px',
          borderBottom:'1px solid var(--border)', fontSize:12, fontWeight:600, color:'var(--muted)',
          letterSpacing:'0.04em', textTransform:'uppercase' }}>
          <span>顯示名稱</span><span>帳號</span><span>角色</span>
        </div>
        {list.map(u => (
          <div key={u.id} style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr 0.7fr', gap:12,
            padding:'13px 20px', borderBottom:'1px solid var(--border)', alignItems:'center',
            fontSize:14, transition:'background .15s' }}
            onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background='rgba(60,52,40,0.02)'}
            onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background='transparent'}>
            <div style={{ display:'flex', alignItems:'center', gap:11 }}>
              <div style={{ width:32, height:32, borderRadius:9, flexShrink:0,
                background: u.role==='admin' ? 'linear-gradient(155deg,#9a9389,#6f685d)' : 'var(--accent)',
                display:'grid', placeItems:'center', fontSize:12, fontWeight:600, color:'#fff' }}>
                {(u.displayName || u.username)[0]}
              </div>
              <span style={{ fontWeight:500 }}>{u.displayName || u.username}</span>
            </div>
            <span style={{ fontSize:13, color:'var(--muted)', fontFamily:'monospace' }}>@{u.username}</span>
            <span>{u.role==='admin' ? <Tag color="#a78bfa">admin</Tag> : <Tag color="var(--muted)">user</Tag>}</span>
          </div>
        ))}
        {list.length === 0 && (
          <div style={{ padding:32, textAlign:'center', fontSize:14, color:'var(--muted)' }}>還沒有用戶</div>
        )}
      </div>
      <div style={{ fontSize:12, color:'var(--muted)', marginTop:10 }}>* 修改密碼與刪除為未來功能。</div>

      <style>{`@media (max-width:720px){.ax-user-form{grid-template-columns:1fr !important}}`}</style>
    </div>
  );
}
