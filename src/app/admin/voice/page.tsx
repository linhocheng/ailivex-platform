'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface PowerState { version: string; on: boolean; minInstances: number; reconciling: boolean; }

export default function AdminVoicePower() {
  const [state, setState] = useState<PowerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [msg, setMsg] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/admin/voice-power').then(r => r.json()).catch(() => null);
    if (r && !r.error) setState(r);
    else if (r?.error) setMsg(r.error);
    setLoading(false);
    return r as PowerState | null;
  }, []);

  useEffect(() => {
    load();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  async function toggle() {
    if (!state || switching) return;
    const target = !state.on;
    setSwitching(true); setMsg('');
    const r = await fetch('/api/admin/voice-power', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: target }),
    }).then(r => r.json()).catch(() => null);
    if (!r?.ok) {
      setMsg(r?.error || '切換失敗');
      setSwitching(false);
      return;
    }
    // 輪詢直到 Cloud Run 完成套用
    pollRef.current = setInterval(async () => {
      const s = await load();
      if (s && s.on === target && !s.reconciling) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setSwitching(false);
        setMsg(target ? '已開啟，暖機約 1 分鐘後可接通話' : '已關閉，常駐實例已釋放');
        setTimeout(() => setMsg(''), 6000);
      }
    }, 4000);
  }

  if (loading) return <div style={{ color: 'var(--muted)' }}>載入中…</div>;

  const on = state?.on ?? false;

  return (
    <div style={{ maxWidth: 680 }}>
      <h1 style={{ fontSize: 22, fontWeight: 650, marginBottom: 6 }}>即時語音</h1>
      <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 24 }}>
        控制語音引擎（{state?.version}）。關閉時前台撥號鈕立即變為「現在無法撥號」，同時釋放雲端常駐停止計費
        （雲端實例最長 15 分鐘內完全回收，期間新撥號已被前台擋下）；開啟後暖機約 1 分鐘，之後通話正常。
        開啟後若連續 3 小時沒有任何撥號，系統會自動關閉，防止忘記關機。
      </p>

      <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '22px 24px',
        background: 'var(--panel)', display: 'flex', alignItems: 'center', gap: 18 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 4 }}>
            語音引擎{switching ? '切換中…' : on ? '運轉中' : '已停止'}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
            {switching
              ? '正在套用設定，請稍候（最多約 1 分鐘）'
              : on
                ? '常駐 1 台（2 CPU），語音通話可接聽，計費中'
                : '前台已擋撥號、零常駐費用（雲端實例 15 分鐘內完全回收）'}
          </div>
        </div>
        <button onClick={toggle} disabled={switching} aria-label="切換語音引擎"
          style={{ position: 'relative', width: 58, height: 32, borderRadius: 16, border: '1px solid var(--border)',
            cursor: switching ? 'default' : 'pointer', transition: 'background .25s',
            background: on ? 'var(--accent)' : 'rgba(60,52,40,0.12)', opacity: switching ? 0.6 : 1 }}>
          <span style={{ position: 'absolute', top: 3, left: on ? 29 : 3, width: 24, height: 24, borderRadius: '50%',
            background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.25)', transition: 'left .25s' }} />
        </button>
      </div>

      {msg && <p style={{ fontSize: 13.5, color: 'var(--accent-2)', marginTop: 14 }}>{msg}</p>}
    </div>
  );
}
