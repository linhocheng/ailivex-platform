'use client';

import { useEffect, useState, useCallback } from 'react';
import { Icon } from '@/app/_components/ui';

interface NodeState { value: string; label: string; isDefault: boolean; }
type Prompts = Record<string, NodeState>;

const NODE_ORDER = ['antiSycophancy', 'timeRule', 'abilities', 'voiceRules'];
const NODE_HINT: Record<string, string> = {
  antiSycophancy: '對抗底模討好天性。緊貼角色靈魂後注入，套所有角色。只定目標，風格交給各角色個性。',
  timeRule: '角色判斷「剛才 / 昨天 / 上次」的時間用語規則。',
  abilities: '角色可呼叫的工具說明（remember / write_document）。',
  voiceRules: '即時語音的說話規範（說人話、不條列、簡體中文、數字念法等）。',
};

export default function AdminGlobalPrompts() {
  const [prompts, setPrompts] = useState<Prompts>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch('/api/admin/global-prompts').then(r => r.json()).catch(() => ({ prompts: {} }));
    setPrompts(r.prompts || {});
    setDraft(Object.fromEntries(Object.entries(r.prompts || {}).map(([k, v]) => [k, (v as NodeState).value])));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirty = NODE_ORDER.some(k => prompts[k] && draft[k] !== prompts[k].value);

  async function save() {
    setSaving(true); setMsg('');
    const r = await fetch('/api/admin/global-prompts', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    }).then(r => r.json()).catch(() => null);
    setSaving(false);
    if (r?.ok) { setMsg('已儲存，下一通通話生效'); await load(); }
    else setMsg('儲存失敗');
    setTimeout(() => setMsg(''), 4000);
  }

  function resetNode(k: string) {
    // 清空＝後台 PUT 時視為恢復預設
    setDraft(d => ({ ...d, [k]: '' }));
  }

  if (loading) return <div style={{ color: 'var(--muted)' }}>載入中…</div>;

  return (
    <div style={{ maxWidth: 880 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 650, marginBottom: 6 }}>全局 Prompt</h1>
          <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            套用<strong>所有角色</strong>的系統端天條。改完存檔，下一通通話即生效，不用重新部署。
            清空某塊＝恢復系統預設。
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 22, marginTop: 24 }}>
        {NODE_ORDER.map(k => {
          const node = prompts[k];
          if (!node) return null;
          const changed = draft[k] !== node.value;
          return (
            <div key={k} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px',
              background: 'var(--panel)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{node.label}</span>
                {node.isDefault && (
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, background: 'rgba(60,52,40,0.06)',
                    color: 'var(--muted)', border: '1px solid var(--border)' }}>預設值</span>
                )}
                {changed && (
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5,
                    background: 'color-mix(in oklab, var(--accent) 14%, transparent)', color: 'var(--accent)' }}>未存</span>
                )}
                <button onClick={() => resetNode(k)} style={{ marginLeft: 'auto', padding: '5px 10px', fontSize: 12,
                  borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)',
                  cursor: 'pointer' }}>
                  恢復預設
                </button>
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.55 }}>{NODE_HINT[k]}</p>
              <textarea value={draft[k] ?? ''} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
                placeholder="（空白＝使用系統預設）"
                style={{ width: '100%', minHeight: k === 'antiSycophancy' || k === 'voiceRules' ? 170 : 90,
                  resize: 'vertical', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8,
                  padding: '11px 13px', color: 'var(--text)', fontSize: 14, lineHeight: 1.7, outline: 'none',
                  fontFamily: 'inherit' }} />
            </div>
          );
        })}
      </div>

      <div style={{ position: 'sticky', bottom: 0, marginTop: 24, padding: '14px 0',
        display: 'flex', alignItems: 'center', gap: 14, background: 'linear-gradient(transparent, var(--bg) 30%)' }}>
        <button onClick={save} disabled={!dirty || saving}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 22px', borderRadius: 8,
            border: 'none', fontSize: 14.5, fontWeight: 600, cursor: dirty && !saving ? 'pointer' : 'default',
            background: dirty && !saving ? 'var(--accent)' : 'rgba(60,52,40,0.1)', color: '#fff',
            opacity: dirty && !saving ? 1 : 0.55 }}>
          <Icon name="check" size={16} />{saving ? '儲存中…' : '儲存'}
        </button>
        {msg && <span style={{ fontSize: 13.5, color: 'var(--accent-2)' }}>{msg}</span>}
      </div>
    </div>
  );
}
