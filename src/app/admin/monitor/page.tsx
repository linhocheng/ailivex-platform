'use client';

/**
 * /admin/monitor — 監控中台（Phase 1：現成資料 + 真實探測）
 * 版面 = 2026-07-10 Adam 確認的 UIUX 稿 v2；Phase 2 才有的資料一律灰燈誠實標示。
 */
import { useCallback, useEffect, useState } from 'react';

type Light = { key: string; name: string; status: 'green' | 'red' | 'amber' | 'gray'; why: string };
type Funnel = { feature: string; ok?: number; fail?: number; running?: number; stuck?: number; phase2: boolean };
type Failure = { at: number; feature: string; userId: string; characterId: string; error: string; kind: 'fail' | 'stuck' };
type Provider = { name: string; use: string; calls: number | null; fails: number | null; lastOkAt: number | null; lastError: string | null; cost: number | null; costNote?: string; phase2: boolean; partial?: boolean };
type SeriesPoint = { h: string; at: number; dialogueOk: number; dialogueFail: number; rooms: number | null; minInstances: number | null };
type BillingRow = { service: string; avgInstances: number; instanceHours: number };
interface Monitor {
  generatedAt: string; windowH: number; lights: Light[];
  gauges: { voice: { current: number; ceiling: number; safeGate: number; perInstance: number; minInstances: number; maxInstances: number; note: string }; queue: { pending: number; stuck: number } };
  online: { voiceCount: number; voiceRooms: { characterId: string; userId: string; participants: number; durationMin: number | null }[]; textActive15m: number; todayActive: number; weekActive: number };
  funnel: Funnel[]; failures: Failure[]; providers: Provider[];
  series: SeriesPoint[]; billing: BillingRow[] | null;
}

const DOT: Record<Light['status'], string> = {
  green: 'var(--accent-2)', red: 'var(--danger)', amber: '#c08a3e', gray: '#b0aa9e',
};
const WINDOWS = [{ label: '今日', h: 24 }, { label: '7 天', h: 168 }, { label: '30 天', h: 720 }];

function ago(ts: number | null): string {
  if (!ts) return '—';
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  if (m < 1440) return `${Math.round(m / 60)} 小時前`;
  return `${Math.round(m / 1440)} 天前`;
}

export default function MonitorPage() {
  const [data, setData] = useState<Monitor | null>(null);
  const [windowH, setWindowH] = useState(24);
  const [err, setErr] = useState('');

  const load = useCallback(async (h: number) => {
    try {
      const r = await fetch(`/api/admin/monitor?window=${h}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`${r.status}`);
      setData(await r.json()); setErr('');
    } catch (e) { setErr(String(e)); }
  }, []);

  useEffect(() => {
    load(windowH);
    const t = setInterval(() => load(windowH), 30_000);
    return () => clearInterval(t);
  }, [windowH, load]);

  return (
    <div>
      <div className="ax-enter" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 22, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 26, margin: 0, fontWeight: 600, letterSpacing: '-0.02em' }}>監控中台</h1>
          <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '6px 0 0' }}>
            上線狀態、使用漏斗、第三方依賴與服務燈號。燈色只從證據亮；灰燈＝管道未接（Phase 2），不裝綠。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {data && <span style={{ fontSize: 12, color: 'var(--muted)', marginRight: 8 }}>更新 {ago(Date.parse(data.generatedAt))} · 30s 自動刷新</span>}
          {WINDOWS.map(w => (
            <button key={w.h} onClick={() => setWindowH(w.h)}
              style={{ padding: '6px 14px', borderRadius: 99, fontSize: 13, border: '1px solid var(--border)', cursor: 'pointer',
                background: windowH === w.h ? 'var(--text)' : 'var(--panel)', color: windowH === w.h ? 'var(--panel)' : 'var(--muted)' }}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {err && <div style={{ padding: 14, borderRadius: 'var(--radius)', background: 'color-mix(in oklab, var(--danger) 10%, transparent)', color: 'var(--danger)', marginBottom: 16 }}>載入失敗：{err}</div>}
      {!data && !err && <div style={{ color: 'var(--muted)', padding: 40, textAlign: 'center' }}>載入中…</div>}
      {data && <>

        {/* ① 服務燈號 */}
        <Section title="服務燈號" note="綠＝近期成功證據 · 紅＝失敗/逾期 · 橘＝降級 · 灰＝無流量或未接線">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {data.lights.map(l => (
              <div key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 16px', borderRadius: 'var(--radius)', background: 'var(--panel)', border: '1px solid var(--border)', minWidth: 150 }}>
                <span style={{ width: 10, height: 10, borderRadius: 99, flex: 'none', background: DOT[l.status], boxShadow: l.status !== 'gray' ? `0 0 0 3px color-mix(in oklab, ${DOT[l.status]} 22%, transparent)` : 'none' }} />
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{l.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{l.why}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ①.5 容量水位 */}
        <Section title="容量水位" note={`分母來自 2026-07-11 負載實測（單台 ${data.gauges.voice.perInstance} 路穩態）· 70% 黃 90% 紅`}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px,1fr))', gap: 14 }}>
            <Gauge name="語音通話併發" cur={data.gauges.voice.current} max={data.gauges.voice.ceiling}
              why={data.gauges.voice.note} unit="路" />
            <Gauge name="語音 agent 常駐" cur={data.gauges.voice.minInstances} max={data.gauges.voice.maxInstances}
              why={`min=${data.gauges.voice.minInstances}（變速箱檔位）· max=${data.gauges.voice.maxInstances}（成本保險絲）`} unit="台" noColor />
            <Gauge name="進行中任務" cur={data.gauges.queue.pending} max={Math.max(10, data.gauges.queue.pending)}
              why="非同步緩衝 — 隊長不算爆，持續變長要看消化速率" unit="件" noColor />
            <Gauge name="卡死任務" cur={data.gauges.queue.stuck} max={Math.max(1, data.gauges.queue.stuck)}
              why="running/pending 超時無錯誤訊息 — 需人工介入" unit="件" alert={data.gauges.queue.stuck > 0} />
          </div>
        </Section>

        {/* ①.6 計費錶 */}
        {data.billing !== null && (
          <Section title="計費錶（Cloud Run）" note="billable_instance_time 真值 — 驗「不燒錢了」看這裡，不看設定畫面">
            <Table head={['服務', `${data.windowH}h 平均計費台數`, '實例時']}
              rows={data.billing.map(b => [
                <span key="s" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>{b.service}</span>,
                String(b.avgInstances),
                <b key="h">{b.instanceHours}</b>,
              ])} />
          </Section>
        )}

        {/* ①.7 趨勢 */}
        <Section title="趨勢" note="每小時一點（rollup 快照）· 快照不是趨勢，這裡才是趨勢">
          {data.series.length < 2
            ? <div style={{ fontSize: 13, color: 'var(--muted)', padding: '14px 4px' }}>快照累積中（每小時一點）——資料點滿兩個後這裡會長出曲線。</div>
            : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px,1fr))', gap: 14 }}>
                <Spark name="語音房間（每時抽樣）" pts={data.series.map(s => s.rooms)} />
                <Spark name="常駐台數（變速箱檔位）" pts={data.series.map(s => s.minInstances)} />
                <Spark name="文字對話量（每時）" pts={data.series.map(s => s.dialogueOk + s.dialogueFail)}
                  marks={data.series.map(s => s.dialogueFail > 0)} />
              </div>}
        </Section>

        {/* ② 在線用戶 */}
        <Section title="在線用戶" note="語音＝LiveKit 房間現場（不是鏡子）· 文字＝近 15 分鐘有對話更新">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px,1fr))', gap: 14, marginBottom: 14 }}>
            <Stat k="語音通話中" v={data.online.voiceCount} unit="人" hot={data.online.voiceCount > 0} live />
            <Stat k="活躍（15 分內）" v={data.online.textActive15m} unit="人" />
            <Stat k="今日活躍" v={data.online.todayActive} unit="人" />
            <Stat k="本週活躍" v={data.online.weekActive} unit="人" />
          </div>
          {data.online.voiceRooms.length > 0 && (
            <Table head={['通話中用戶', '角色', '已通話', '房內人數']}
              rows={data.online.voiceRooms.map(r => [r.userId, r.characterId, r.durationMin != null ? `${r.durationMin} 分` : '—', String(r.participants)])} />
          )}
        </Section>

        {/* ③ 使用狀況 */}
        <Section title="使用狀況" note="灰列＝Phase 2 接事件脊椎後才有 · 橘＝卡死（running 超時）">
          <Table head={['功能', '成功 / 失敗', '成功率', '進行中', '異常']}
            rows={data.funnel.map(f => {
              if (f.phase2) return [f.feature, '—', <span key="p" style={{ color: 'var(--muted)', fontSize: 12 }}>Phase 2 接線</span>, '—', ''];
              const total = (f.ok || 0) + (f.fail || 0);
              const rate = total ? Math.round((f.ok || 0) / total * 1000) / 10 : null;
              return [
                f.feature, `${f.ok || 0} / ${f.fail || 0}`,
                rate == null ? '—' : <b key="r" style={{ color: rate < 90 ? 'var(--danger)' : 'inherit' }}>{rate}%</b>,
                String(f.running || 0),
                (f.stuck || 0) > 0 ? <Tag key="s" kind="stuck">{f.stuck} 卡死</Tag> : '',
              ];
            })} />
          {data.failures.length > 0 && <>
            <div style={{ fontSize: 14, fontWeight: 600, margin: '16px 0 10px' }}>最近異常事件（{data.failures.length}）</div>
            <Table head={['時間', '功能', '用戶', '角色', '錯誤訊息', '類型']}
              rows={data.failures.map(f => [
                ago(f.at), f.feature, f.userId, f.characterId,
                <span key="e" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--danger)', background: 'color-mix(in oklab, var(--danger) 7%, transparent)', padding: '2px 8px', borderRadius: 4, display: 'inline-block', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.error || '（無訊息）'}</span>,
                <Tag key="t" kind={f.kind}>{f.kind === 'stuck' ? '卡死' : '失敗'}</Tag>,
              ])} />
          </>}
          {data.failures.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>時間窗內無失敗、無卡死。</div>}
        </Section>

        {/* ④ 第三方依賴 */}
        <Section title="第三方依賴" note="被動亮燈：不主動打付費 API 探測 · 灰＝Phase 2 接呼叫結果">
          <Table head={['', '供應商', '用途', `${data.windowH}h 呼叫`, '失敗', '最後成功', '最後錯誤', '成本(估)']}
            rows={data.providers.map(p => {
              // 紅=失敗率 ≥30%（真的在壞）；橘=有零星失敗但大多成功；不因 999 成功 1 失敗就全紅
              const failRate = p.fails && p.calls ? p.fails / p.calls : (p.fails ? 1 : 0);
              const status: Light['status'] = p.phase2 ? 'gray'
                : failRate >= 0.3 ? 'red'
                : (p.fails && p.fails > 0) ? 'amber'
                : (p.calls || p.lastOkAt ? 'green' : 'gray');
              return [
                <span key="d" style={{ width: 9, height: 9, borderRadius: 99, display: 'inline-block', background: DOT[status] }} />,
                p.name, <span key="u" style={{ color: 'var(--muted)', fontSize: 12.5 }}>{p.use}</span>,
                p.calls != null ? String(p.calls) : (p.phase2 ? 'Phase 2' : '—'),
                p.fails != null ? String(p.fails) : '—',
                ago(p.lastOkAt),
                p.lastError ? <span key="le" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'var(--danger)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{p.lastError}</span> : '—',
                p.costNote || (p.cost != null ? `$${p.cost.toFixed(2)}` : '—'),
              ];
            })} />
        </Section>
      </>}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="ax-enter" style={{ marginBottom: 26 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 11, gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{note}</span>
      </div>
      {children}
    </div>
  );
}

function Stat({ k, v, unit, hot, live }: { k: string; v: number; unit: string; hot?: boolean; live?: boolean }) {
  return (
    <div style={{ padding: '16px 20px', borderRadius: 'var(--radius)', background: 'var(--panel)', border: '1px solid', borderColor: hot ? 'color-mix(in oklab, var(--accent) 40%, var(--border))' : 'var(--border)', position: 'relative', overflow: 'hidden' }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        {k}{live && <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 99, background: 'color-mix(in oklab, var(--accent-2) 16%, transparent)', color: 'var(--accent-2)', fontWeight: 600, marginLeft: 8 }}>LIVE</span>}
      </div>
      <div style={{ fontSize: 29, fontWeight: 600, letterSpacing: '-0.03em', marginTop: 4 }}>{v}<span style={{ fontSize: 14, fontWeight: 400, color: 'var(--muted)', marginLeft: 3 }}>{unit}</span></div>
    </div>
  );
}

function Gauge({ name, cur, max, why, unit, noColor, alert }: { name: string; cur: number; max: number; why: string; unit: string; noColor?: boolean; alert?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.round(cur / max * 100)) : 0;
  const color = alert ? 'var(--danger)' : noColor ? 'var(--accent-2)' : pct >= 90 ? 'var(--danger)' : pct >= 70 ? '#c08a3e' : 'var(--accent-2)';
  return (
    <div style={{ padding: '15px 18px', borderRadius: 'var(--radius)', background: 'var(--panel)', border: '1px solid', borderColor: alert || (!noColor && pct >= 90) ? 'color-mix(in oklab, var(--danger) 45%, var(--border))' : (!noColor && pct >= 70) ? 'color-mix(in oklab, #c08a3e 45%, var(--border))' : 'var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 9 }}>
        <span style={{ fontSize: 13.5, fontWeight: 500 }}>{name}</span>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}><b style={{ fontSize: 16, color: 'var(--text)', fontWeight: 600 }}>{cur}</b> / {max} {unit}</span>
      </div>
      <div style={{ height: 9, borderRadius: 99, background: 'var(--bg-2)', overflow: 'hidden', position: 'relative' }}>
        <div style={{ height: '100%', borderRadius: 99, width: `${pct}%`, background: color, transition: 'width .3s' }} />
        {!noColor && <>
          <span style={{ position: 'absolute', top: -2, bottom: -2, left: '70%', width: 1.5, background: 'rgba(52,44,34,0.3)' }} />
          <span style={{ position: 'absolute', top: -2, bottom: -2, left: '90%', width: 1.5, background: 'rgba(52,44,34,0.3)' }} />
        </>}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 7 }}>{why}</div>
    </div>
  );
}

function Spark({ name, pts, marks }: { name: string; pts: (number | null)[]; marks?: boolean[] }) {
  const vals = pts.map(v => v ?? 0);
  const max = Math.max(1, ...vals);
  const last = vals[vals.length - 1];
  const W = 220, H = 44;
  const x = (i: number) => vals.length > 1 ? (i / (vals.length - 1)) * W : 0;
  const y = (v: number) => H - (v / max) * (H - 4) - 2;
  const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <div style={{ padding: '15px 18px', borderRadius: 'var(--radius)', background: 'var(--panel)', border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 500 }}>{name}</span>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>最新 <b style={{ fontSize: 15, color: 'var(--text)' }}>{last}</b> · 峰 {max}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }} preserveAspectRatio="none">
        <path d={path} fill="none" stroke="var(--accent-2)" strokeWidth={1.8} strokeLinejoin="round" />
        {marks?.map((m, i) => m ? <circle key={i} cx={x(i)} cy={y(vals[i])} r={2.6} fill="var(--danger)" /> : null)}
      </svg>
    </div>
  );
}

function Tag({ kind, children }: { kind: 'fail' | 'stuck'; children: React.ReactNode }) {
  const c = kind === 'stuck' ? '#c08a3e' : 'var(--danger)';
  return <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 99, fontWeight: 500, background: `color-mix(in oklab, ${c} 14%, transparent)`, color: c }}>{children}</span>;
}

function Table({ head, rows }: { head: React.ReactNode[]; rows: React.ReactNode[][] }) {
  return (
    <div style={{ overflowX: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--panel)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{head.map((h, i) => <th key={i} style={{ textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--muted)', padding: '9px 14px', borderBottom: '1px solid var(--border)', background: 'var(--panel-2)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => <td key={j} style={{ padding: '10px 14px', fontSize: 13.5, borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border)' }}>{c}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}
