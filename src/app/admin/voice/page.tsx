'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface PowerState { version: string; on: boolean; minInstances: number; reconciling: boolean; }
interface CapacityState {
  powerOn: boolean; gear: 'off' | 'standby' | 'event';
  desiredMin: number; cloudRunMin: number | null; cloudRunMax: number | null;
  eventMode: { min: number; until: string } | null;
  rooms: number | null; capacity: number; perInstance: number;
}

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

      {on && <CapacityPanel />}
    </div>
  );
}

/** 三段變速箱面板：檔位/水位顯示 + 活動檔進出。降檔升檔由調節器自動，人只管換檔。 */
function CapacityPanel() {
  const [cap, setCap] = useState<CapacityState | null>(null);
  const [busy, setBusy] = useState(false);
  const [cmsg, setCmsg] = useState('');

  const loadCap = useCallback(async () => {
    const r = await fetch('/api/admin/voice-capacity').then(r => r.json()).catch(() => null);
    if (r && !r.error) setCap(r);
  }, []);

  useEffect(() => {
    loadCap();
    const t = setInterval(loadCap, 15_000);
    return () => clearInterval(t);
  }, [loadCap]);

  async function act(body: Record<string, unknown>, doneMsg: string) {
    if (busy) return;
    setBusy(true); setCmsg('');
    const r = await fetch('/api/admin/voice-capacity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setCmsg(r?.error || '操作失敗'); return; }
    setCmsg(doneMsg);
    setTimeout(() => setCmsg(''), 6000);
    loadCap();
  }

  if (!cap) return null;
  const inEvent = cap.gear === 'event';
  const eventLeft = cap.eventMode ? Math.max(0, Math.round((Date.parse(cap.eventMode.until) - Date.now()) / 60_000)) : 0;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '20px 24px', background: 'var(--panel)', marginTop: 18 }}>
      <div style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 4 }}>
        容量變速箱：{inEvent ? `活動檔（剩 ${eventLeft} 分自動回待命）` : '待命檔（水位自動調節）'}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 14 }}>
        目前常駐 <b style={{ color: 'var(--text)' }}>{cap.cloudRunMin ?? '?'}</b> 台（上限 {cap.cloudRunMax} 台）
        ・通話中 <b style={{ color: 'var(--text)' }}>{cap.rooms ?? '?'}</b> / 容量 {cap.capacity} 路（{cap.perInstance} 路/台，實測值）。
        待命檔下水位 ≥70% 自動加開、低於 40% 持續一小時自動縮回；活動檔鎖定台數、到期自動降回。
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {!inEvent && <>
          <button disabled={busy} onClick={() => act({ action: 'event', min: cap.cloudRunMax ?? 3, hours: 2 }, '已進活動檔，2 小時後自動回待命')}
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--accent)', color: '#fff', fontSize: 13.5, fontWeight: 500, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
            進活動檔（{cap.cloudRunMax ?? 3} 台 · 2 小時）
          </button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>發表會 / demo 前按，時間到自動回，不會忘關</span>
        </>}
        {inEvent && (
          <button disabled={busy} onClick={() => act({ action: 'standby' }, '已回待命檔 min=1')}
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel-2)', color: 'var(--text)', fontSize: 13.5, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
            提前退活動檔（回待命）
          </button>
        )}
      </div>
      {cmsg && <p style={{ fontSize: 13, color: 'var(--accent-2)', marginTop: 12 }}>{cmsg}</p>}
    </div>
  );
}
