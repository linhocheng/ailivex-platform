'use client';

import { useEffect, useState } from 'react';
import { Icon, Dot, Tag, Field, TextInput, GlowButton } from '@/app/_components/ui';

interface User {
  id: string; username: string; displayName: string; role: string;
  voiceSecondsLimit: number | null; voiceSecondsUsed: number;
  docsLimit: number | null; docsUsed: number;
}

// 秒 → 顯示字串（1.5h / 45m）
function fmtSeconds(s: number): string {
  if (s >= 3600) { const h = s / 3600; return `${Number.isInteger(h) ? h : h.toFixed(1)}h`; }
  return `${Math.ceil(s / 60)}m`;
}

// 語音剩餘秒數（null = 不限）
function voiceRemaining(u: User): number | null {
  return u.voiceSecondsLimit === null ? null : Math.max(0, u.voiceSecondsLimit - u.voiceSecondsUsed);
}

// 時間已用完（有設上限且剩餘歸零）
function isVoiceExhausted(u: User): boolean {
  const r = voiceRemaining(u);
  return r !== null && r <= 0;
}

// 文件已用完（有設上限且剩餘歸零）
function isDocsExhausted(u: User): boolean {
  return u.docsLimit !== null && (u.docsLimit - u.docsUsed) <= 0;
}

export default function AdminUsers() {
  const [list, setList] = useState<User[]>([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 用量編輯列：展開中的 userId + 輸入值（時數以小時為單位輸入，存秒）＋ 新密碼
  const [quotaEdit, setQuotaEdit] = useState<{ userId: string; hours: string; docs: string; newPassword: string } | null>(null);
  const [quotaBusy, setQuotaBusy] = useState(false);
  // 期滿警示面板：每個額度用完的用戶各一格加值輸入（key = userId）
  const [topupInputs, setTopupInputs] = useState<Record<string, string>>({});
  const [docTopupInputs, setDocTopupInputs] = useState<Record<string, string>>({});

  // 加值：新上限 = 已用 + 加值（「再給他 N」的語意，不是重設總量）
  async function topup(u: User) {
    const hours = Number((topupInputs[u.id] || '').trim());
    if (!Number.isFinite(hours) || hours <= 0) {
      setMsg({ ok: false, text: '請輸入 > 0 的加值時數（小時）' }); return;
    }
    setQuotaBusy(true);
    const r = await fetch('/api/admin/users', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: u.id, voiceSecondsLimit: u.voiceSecondsUsed + Math.round(hours * 3600) }),
    }).then(r => r.json()).catch(() => null);
    setQuotaBusy(false);
    if (r?.ok) {
      setMsg({ ok: true, text: `已為「${u.displayName || u.username}」加值 ${hours} 小時` });
      setTimeout(() => setMsg(null), 2600);
      setTopupInputs(prev => { const n = { ...prev }; delete n[u.id]; return n; });
      load();
    } else setMsg({ ok: false, text: r?.error || '加值失敗' });
  }

  async function topupDocs(u: User) {
    const count = Number((docTopupInputs[u.id] || '').trim());
    if (!Number.isInteger(count) || count <= 0) {
      setMsg({ ok: false, text: '請輸入 > 0 的加購份數（整數）' }); return;
    }
    setQuotaBusy(true);
    const r = await fetch('/api/admin/users', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: u.id, docsLimit: u.docsUsed + count }),
    }).then(r => r.json()).catch(() => null);
    setQuotaBusy(false);
    if (r?.ok) {
      setMsg({ ok: true, text: `已為「${u.displayName || u.username}」加購 ${count} 份文件` });
      setTimeout(() => setMsg(null), 2600);
      setDocTopupInputs(prev => { const n = { ...prev }; delete n[u.id]; return n; });
      load();
    } else setMsg({ ok: false, text: r?.error || '加購失敗' });
  }

  // 更新密碼：直接生效
  async function savePassword() {
    if (!quotaEdit) return;
    const pw = quotaEdit.newPassword;
    if (pw.length < 6) { setMsg({ ok: false, text: '密碼至少需 6 碼' }); return; }
    setQuotaBusy(true);
    const r = await fetch('/api/admin/users', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: quotaEdit.userId, newPassword: pw }),
    }).then(r => r.json()).catch(() => null);
    setQuotaBusy(false);
    if (r?.ok) {
      setMsg({ ok: true, text: '密碼已更新，立即生效' });
      setTimeout(() => setMsg(null), 2600);
      setQuotaEdit({ ...quotaEdit, newPassword: '' });
    } else setMsg({ ok: false, text: r?.error || '密碼更新失敗' });
  }

  // 刪除用戶：連同其角色指派一起清掉
  async function removeUser(u: User) {
    if (!confirm(`確定刪除用戶「${u.displayName || u.username}」（@${u.username}）？\n此操作會一併移除其所有角色指派，無法復原。`)) return;
    setQuotaBusy(true);
    const r = await fetch('/api/admin/users', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: u.id }),
    }).then(r => r.json()).catch(() => null);
    setQuotaBusy(false);
    if (r?.ok) {
      setMsg({ ok: true, text: `已刪除「${u.displayName || u.username}」` });
      setTimeout(() => setMsg(null), 2600);
      setQuotaEdit(null);
      load();
    } else setMsg({ ok: false, text: r?.error || '刪除失敗' });
  }

  function openQuota(u: User) {
    setQuotaEdit({
      userId: u.id,
      hours: u.voiceSecondsLimit === null ? '' : String(u.voiceSecondsLimit / 3600),
      docs: u.docsLimit === null ? '' : String(u.docsLimit),
      newPassword: '',
    });
  }

  async function saveQuota(extra?: { resetVoiceUsed?: boolean; resetDocsUsed?: boolean }) {
    if (!quotaEdit) return;
    const hoursTrim = quotaEdit.hours.trim();
    const docsTrim = quotaEdit.docs.trim();
    const hoursNum = hoursTrim === '' ? null : Number(hoursTrim);
    const docsNum = docsTrim === '' ? null : Number(docsTrim);
    if (hoursNum !== null && (!Number.isFinite(hoursNum) || hoursNum < 0)) {
      setMsg({ ok: false, text: '語音時數需為 >= 0 的數字（留空 = 不限）' }); return;
    }
    if (docsNum !== null && (!Number.isFinite(docsNum) || docsNum < 0)) {
      setMsg({ ok: false, text: '文件份數需為 >= 0 的整數（留空 = 不限）' }); return;
    }
    setQuotaBusy(true);
    const r = await fetch('/api/admin/users', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: quotaEdit.userId,
        voiceSecondsLimit: hoursNum === null ? null : Math.round(hoursNum * 3600),
        docsLimit: docsNum === null ? null : Math.round(docsNum),
        ...(extra || {}),
      }),
    }).then(r => r.json()).catch(() => null);
    setQuotaBusy(false);
    if (r?.ok) {
      setMsg({ ok: true, text: '用量設定已更新' });
      setTimeout(() => setMsg(null), 2600);
      setQuotaEdit(null);
      load();
    } else setMsg({ ok: false, text: r?.error || '更新失敗' });
  }

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

      {/* 期滿警示：語音時數或文件份數用完的用戶，開頁即見，加值確認後消失 */}
      {list.filter(u => isVoiceExhausted(u) || isDocsExhausted(u)).length > 0 && (
        <div className="ax-enter" style={{ background:'rgba(181,101,74,0.07)', border:'1px solid rgba(181,101,74,0.35)',
          borderRadius:'var(--radius)', padding:'18px 22px', marginBottom:22 }}>
          <div style={{ fontSize:14.5, fontWeight:600, marginBottom:4, color:'#b5654a', display:'flex', alignItems:'center', gap:8 }}>
            <Dot color="#b5654a" pulse />以下用戶的額度已用完
          </div>
          <div style={{ fontSize:12.5, color:'var(--muted)', marginBottom:14 }}>
            時數用完無法撥打語音、份數用完無法生成文件。輸入加值並確認後恢復（新上限 = 已用 + 加值）。
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {list.filter(u => isVoiceExhausted(u) || isDocsExhausted(u)).map(u => (
              <div key={u.id} style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                <span style={{ fontSize:14, fontWeight:500, minWidth:120 }}>{u.displayName || u.username}</span>
                {isVoiceExhausted(u) && (
                  <span style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ fontSize:12, color:'#b5654a', fontFamily:'monospace' }}>
                      時間已用完（{fmtSeconds(u.voiceSecondsUsed)} / {fmtSeconds(u.voiceSecondsLimit!)}）
                    </span>
                    <TextInput value={topupInputs[u.id] || ''}
                      onChange={e => setTopupInputs(prev => ({ ...prev, [u.id]: e.target.value }))}
                      placeholder="加值時數（小時）" style={{ width:140 }} />
                    <GlowButton onClick={() => topup(u)} disabled={quotaBusy}>確認加值</GlowButton>
                  </span>
                )}
                {isDocsExhausted(u) && (
                  <span style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ fontSize:12, color:'#b5654a', fontFamily:'monospace' }}>
                      文件已用完（{u.docsUsed} / {u.docsLimit} 份）
                    </span>
                    <TextInput value={docTopupInputs[u.id] || ''}
                      onChange={e => setDocTopupInputs(prev => ({ ...prev, [u.id]: e.target.value }))}
                      placeholder="加購份數" style={{ width:110 }} />
                    <GlowButton onClick={() => topupDocs(u)} disabled={quotaBusy}>確認加購</GlowButton>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* List */}
      <div style={{ background:'var(--panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }} className="ax-enter">
        {/* Header */}
        <div className="ax-users-head" style={{ display:'grid', gridTemplateColumns:'1.3fr 0.9fr 0.55fr 1.3fr 0.6fr', gap:12, padding:'12px 20px',
          borderBottom:'1px solid var(--border)', fontSize:12, fontWeight:600, color:'var(--muted)',
          letterSpacing:'0.04em', textTransform:'uppercase' }}>
          <span>顯示名稱</span><span className="ax-users-sub">帳號</span><span className="ax-users-sub">角色</span><span>剩餘（語音 / 文件）</span><span></span>
        </div>
        {list.map(u => (
          <div key={u.id}>
            <div className="ax-users-row" style={{ display:'grid', gridTemplateColumns:'1.3fr 0.9fr 0.55fr 1.3fr 0.6fr', gap:12,
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
              <span className="ax-users-sub" style={{ fontSize:13, color:'var(--muted)', fontFamily:'monospace' }}>@{u.username}</span>
              <span className="ax-users-sub">{u.role==='admin' ? <Tag color="#a78bfa">admin</Tag> : <Tag color="var(--muted)">user</Tag>}</span>
              <span style={{ fontSize:12.5, fontFamily:'monospace' }}>
                {u.voiceSecondsLimit === null
                  ? <span style={{ color:'var(--muted)' }}>語音不限</span>
                  : isVoiceExhausted(u)
                    ? <span style={{ color:'#b5654a', fontWeight:600 }}>時間已用完</span>
                    : <span style={{ color:'#6f8c5f' }}>剩 {fmtSeconds(voiceRemaining(u)!)}<span style={{ color:'var(--muted)', fontWeight:400 }}>（已用 {fmtSeconds(u.voiceSecondsUsed)} / {fmtSeconds(u.voiceSecondsLimit)}）</span></span>}
                <span style={{ color:'var(--muted)' }}>{' · '}</span>
                {u.docsLimit === null
                  ? <span style={{ color:'var(--muted)' }}>文件不限</span>
                  : (u.docsLimit - u.docsUsed) <= 0
                    ? <span style={{ color:'#b5654a', fontWeight:600 }}>文件已用完</span>
                    : <span style={{ color:'var(--muted)' }}>剩 {u.docsLimit - u.docsUsed} 份</span>}
              </span>
              <button onClick={() => quotaEdit?.userId === u.id ? setQuotaEdit(null) : openQuota(u)}
                style={{ fontSize:12.5, padding:'5px 12px', borderRadius:8, cursor:'pointer',
                  border:'1px solid var(--border)', background:'transparent', color:'var(--muted)' }}>
                {quotaEdit?.userId === u.id ? '收合' : '用量'}
              </button>
            </div>
            {quotaEdit?.userId === u.id && (
              <div style={{ padding:'14px 20px', borderBottom:'1px solid var(--border)',
                background:'rgba(60,52,40,0.03)', display:'flex', flexDirection:'column', gap:14 }}>
                {/* 用量設定 */}
                <div style={{ display:'flex', gap:14, alignItems:'flex-end', flexWrap:'wrap' }}>
                  <Field label="語音總時數（小時，留空 = 不限）">
                    <TextInput value={quotaEdit.hours} onChange={e => setQuotaEdit({ ...quotaEdit, hours: e.target.value })} placeholder="例如 2 或 1.5" />
                  </Field>
                  <Field label="文件總份數（留空 = 不限）">
                    <TextInput value={quotaEdit.docs} onChange={e => setQuotaEdit({ ...quotaEdit, docs: e.target.value })} placeholder="例如 5" />
                  </Field>
                  <GlowButton onClick={() => saveQuota()} disabled={quotaBusy} style={{ height:44 }}>儲存</GlowButton>
                  <button onClick={() => saveQuota({ resetVoiceUsed: true })} disabled={quotaBusy}
                    style={{ height:44, fontSize:13, padding:'0 14px', borderRadius:10, cursor:'pointer',
                      border:'1px solid var(--border)', background:'transparent', color:'var(--muted)' }}>
                    語音已用歸零
                  </button>
                  <button onClick={() => saveQuota({ resetDocsUsed: true })} disabled={quotaBusy}
                    style={{ height:44, fontSize:13, padding:'0 14px', borderRadius:10, cursor:'pointer',
                      border:'1px solid var(--border)', background:'transparent', color:'var(--muted)' }}>
                    文件已用歸零
                  </button>
                </div>
                {/* 密碼 + 刪除 */}
                <div style={{ display:'flex', gap:14, alignItems:'flex-end', flexWrap:'wrap',
                  borderTop:'1px dashed var(--border)', paddingTop:14 }}>
                  <Field label="密碼（狀態：已設定，scrypt 加密不顯示明文）">
                    <TextInput type="password" value={quotaEdit.newPassword}
                      onChange={e => setQuotaEdit({ ...quotaEdit, newPassword: e.target.value })}
                      placeholder="輸入新密碼（≥ 6 碼）" autoComplete="new-password" />
                  </Field>
                  <GlowButton onClick={savePassword} disabled={quotaBusy || quotaEdit.newPassword.length < 6} style={{ height:44 }}>
                    更新密碼
                  </GlowButton>
                  <div style={{ flex:1 }} />
                  {u.role !== 'admin' && (
                    <button onClick={() => removeUser(u)} disabled={quotaBusy}
                      style={{ height:44, fontSize:13, padding:'0 16px', borderRadius:10, cursor:'pointer',
                        border:'1px solid rgba(181,101,74,0.5)', background:'rgba(181,101,74,0.08)', color:'#b5654a', fontWeight:500 }}>
                      刪除用戶
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        {list.length === 0 && (
          <div style={{ padding:32, textAlign:'center', fontSize:14, color:'var(--muted)' }}>還沒有用戶</div>
        )}
      </div>
      <div style={{ fontSize:12, color:'var(--muted)', marginTop:10 }}>* 點「用量」展開：時數/份數設定、密碼更新、刪除用戶。刪除會一併移除角色指派。</div>

      <style>{`
        @media (max-width:720px){
          .ax-user-form{grid-template-columns:1fr !important}
          .ax-users-sub{display:none !important}
          .ax-users-head{grid-template-columns:1.2fr 1.4fr auto !important}
          .ax-users-row{grid-template-columns:1.2fr 1.4fr auto !important; row-gap:6px}
          .ax-users-row button{min-height:44px; min-width:64px}
        }
      `}</style>
    </div>
  );
}
