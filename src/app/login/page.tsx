'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wordmark, Icon, Field, TextInput, Dot, Ambient } from '@/app/_components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) { setError('請輸入帳號與密碼'); return; }
    setError(''); setLoading(true);
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).catch(() => null);
    setLoading(false);
    if (!res) { setError('連線失敗，請重試'); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error || '帳號或密碼錯誤'); return; }
    router.push(data.role === 'admin' ? '/admin' : '/lobby');
    router.refresh();
  }

  return (
    <>
      <Ambient />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh', display: 'grid',
        gridTemplateColumns: '1.15fr 1fr' }} className="ax-login">

        {/* Brand side */}
        <div className="ax-login-brand" style={{ position: 'relative', overflow: 'hidden', display: 'flex',
          flexDirection: 'column', justifyContent: 'space-between',
          padding: 'clamp(40px,5vw,64px)', background: 'var(--bg-2)',
          borderRight: '1px solid var(--border)' }}>
          <Wordmark />
          <div style={{ maxWidth: 460 }} className="ax-enter">
            <h1 style={{ fontSize: 'clamp(32px,3.2vw,44px)', lineHeight: 1.12, margin: '0 0 20px',
              fontWeight: 600, letterSpacing: '-0.01em' }}>
              與有<span style={{ color: 'var(--accent)' }}>靈魂</span>的<br />AI 角色相遇
            </h1>
            <div style={{ width: 40, height: 2, background: 'var(--accent)', marginBottom: 20, opacity: 0.7 }} />
            <p style={{ fontSize: 15.5, color: 'var(--muted)', lineHeight: 1.8, margin: 0, maxWidth: 380, fontWeight: 300 }}>
              ailiveX 不是聊天機器人。每個角色都記得你、認識你，並能與你並肩生成策略、企劃與想法。
            </p>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', letterSpacing: '0.06em', fontWeight: 300 }}>
            沉浸式 AI 角色互動平台 · v1.0
          </div>
        </div>

        {/* Form side */}
        <div style={{ display: 'grid', placeItems: 'center', padding: '40px clamp(24px,5vw,40px)',
          background: 'var(--panel-solid)' }}>
          <form onSubmit={submit} style={{ width: '100%', maxWidth: 360 }} className="ax-enter">
            <div className="ax-login-mark" style={{ display: 'none', marginBottom: 26 }}><Wordmark size={20} /></div>
            <div style={{ marginBottom: 30 }}>
              <h2 style={{ fontSize: 24, margin: '0 0 8px', fontWeight: 600 }}>歡迎回來</h2>
              <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0 }}>登入以進入你的角色空間</p>
            </div>
            <div style={{ display: 'grid', gap: 16 }}>
              <Field label="帳號">
                <TextInput value={username} onChange={e => setUsername(e.target.value)}
                  placeholder="輸入帳號" autoComplete="username" />
              </Field>
              <Field label="密碼">
                <TextInput type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="輸入密碼" autoComplete="current-password" />
              </Field>
              {error && (
                <div style={{ fontSize: 13, color: '#b5654a', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Dot color="#b5654a" /> {error}
                </div>
              )}
              <button type="submit" disabled={loading} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                padding: '15px 26px', fontSize: 16, fontWeight: 500, borderRadius: 6,
                border: '1px solid transparent', width: '100%',
                background: 'var(--accent)', color: '#fbfaf6', boxShadow: 'var(--shadow)',
                opacity: loading ? 0.75 : 1, cursor: loading ? 'not-allowed' : 'pointer',
              }}>
                {loading ? (
                  <><span className="ax-spin" style={{ display: 'grid' }}><Icon name="spinner" size={18} /></span>登入中…</>
                ) : '登入'}
              </button>
            </div>
            <p style={{ marginTop: 22, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
              帳號由管理員統一建立
            </p>
          </form>
        </div>
      </div>

      <style>{`
        @media (max-width: 840px) {
          .ax-login { grid-template-columns: 1fr !important; }
          .ax-login-brand { display: none !important; }
          .ax-login-mark { display: block !important; }
        }
      `}</style>
    </>
  );
}
