'use client';

/**
 * 知識與方法 —— 角色的著作層（知識庫）與教練框架層（方法論）管理。
 * 留空即相容：角色沒設定時，對話行為與既有完全一致。
 */
import { useEffect, useState, useCallback } from 'react';
import { Icon, Tag, GlowButton, Panel, Field, TextInput, EmptyState, inputStyle } from '@/app/_components/ui';

interface CharItem { id: string; name: string; }
interface KDocItem {
  id: string; title: string; docType: string; authority: string;
  sourceRef: string; chunkCount: number; createdAt: number | null;
}
interface StepItem { instruction: string; exitCondition: string; }
interface MethodItem {
  id: string; name: string; purpose: string; triggerDesc: string;
  preconditions: string[]; steps: Array<{ order: number; instruction: string; exitCondition?: string }>;
  createdAt: number | null;
}

const DOC_TYPES = [
  { v: 'book', label: '書' }, { v: 'article', label: '文章' }, { v: 'talk', label: '演講' },
  { v: 'interview', label: '訪談' }, { v: 'note', label: '筆記' },
];
const AUTHORITIES = [
  { v: 'canonical', label: '本人原話', color: '#6f8c5f' },
  { v: 'paraphrase', label: '轉述', color: '#60a5fa' },
  { v: 'derived', label: '整理', color: 'var(--muted)' },
];

const selStyle: React.CSSProperties = {
  background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8,
  padding: '8px 10px', color: 'var(--text)', fontSize: 14, outline: 'none', cursor: 'pointer',
};
const taStyle: React.CSSProperties = { ...inputStyle, minHeight: 90, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 };

function fmt(ms: number | null) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' });
}
const authorityMeta = (v: string) => AUTHORITIES.find(a => a.v === v) ?? AUTHORITIES[2];
const docTypeLabel = (v: string) => DOC_TYPES.find(t => t.v === v)?.label ?? v;

export default function AdminKnowledge() {
  const [chars, setChars] = useState<CharItem[]>([]);
  const [charId, setCharId] = useState('');
  const [kdocs, setKdocs] = useState<KDocItem[]>([]);
  const [methods, setMethods] = useState<MethodItem[]>([]);
  const [loading, setLoading] = useState(false);

  // ── 知識入庫表單 ──
  const [kTitle, setKTitle] = useState('');
  const [kType, setKType] = useState('book');
  const [kAuth, setKAuth] = useState('canonical');
  const [kRef, setKRef] = useState('');
  const [kContent, setKContent] = useState('');
  const [kBusy, setKBusy] = useState(false);
  const [kMsg, setKMsg] = useState('');

  // ── 方法論表單（editingId 有值 = 編輯模式）──
  const [editingId, setEditingId] = useState('');
  const [mName, setMName] = useState('');
  const [mPurpose, setMPurpose] = useState('');
  const [mTrigger, setMTrigger] = useState('');
  const [mPre, setMPre] = useState('');
  const [mSteps, setMSteps] = useState<StepItem[]>([{ instruction: '', exitCondition: '' }]);
  const [mBusy, setMBusy] = useState(false);
  const [mMsg, setMMsg] = useState('');

  useEffect(() => {
    fetch('/api/admin/characters').then(r => r.json())
      .then(d => setChars((d.characters || []).map((c: CharItem) => ({ id: c.id, name: c.name }))));
  }, []);

  const load = useCallback(async () => {
    if (!charId) { setKdocs([]); setMethods([]); return; }
    setLoading(true);
    const [k, m] = await Promise.all([
      fetch(`/api/admin/characters/${charId}/knowledge`).then(r => r.json()).catch(() => ({ docs: [] })),
      fetch(`/api/admin/characters/${charId}/methodologies`).then(r => r.json()).catch(() => ({ methodologies: [] })),
    ]);
    setKdocs(k.docs || []);
    setMethods(m.methodologies || []);
    setLoading(false);
  }, [charId]);

  useEffect(() => { load(); }, [load]);

  async function submitKnowledge() {
    if (!charId || !kTitle.trim() || !kContent.trim()) { setKMsg('標題與內容必填'); return; }
    setKBusy(true); setKMsg('切塊與向量化中…（長文要跑一陣子）');
    const r = await fetch(`/api/admin/characters/${charId}/knowledge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: kTitle, docType: kType, authority: kAuth, sourceRef: kRef, content: kContent }),
    }).then(r => r.json()).catch(() => null);
    setKBusy(false);
    if (r?.ok) {
      setKMsg(`已入庫：${r.chunkCount} 塊`);
      setKTitle(''); setKRef(''); setKContent('');
      load();
    } else setKMsg(r?.error || '入庫失敗');
  }

  async function deleteKnowledge(docId: string, title: string) {
    if (!confirm(`確定刪除「${title}」？連同其所有知識塊一併刪除。`)) return;
    await fetch(`/api/admin/characters/${charId}/knowledge/${docId}`, { method: 'DELETE' });
    load();
  }

  function resetMethodForm() {
    setEditingId(''); setMName(''); setMPurpose(''); setMTrigger(''); setMPre('');
    setMSteps([{ instruction: '', exitCondition: '' }]); setMMsg('');
  }

  function editMethod(m: MethodItem) {
    setEditingId(m.id); setMName(m.name); setMPurpose(m.purpose); setMTrigger(m.triggerDesc);
    setMPre((m.preconditions || []).join('\n'));
    setMSteps(m.steps.map(s => ({ instruction: s.instruction, exitCondition: s.exitCondition || '' })));
    setMMsg('');
  }

  async function submitMethod() {
    const steps = mSteps.filter(s => s.instruction.trim());
    if (!charId || !mName.trim() || !mPurpose.trim() || !mTrigger.trim() || steps.length === 0) {
      setMMsg('名稱／目的／觸發描述／至少一步 必填'); return;
    }
    setMBusy(true); setMMsg('儲存中…');
    const payload = {
      name: mName, purpose: mPurpose, triggerDesc: mTrigger,
      preconditions: mPre.split('\n').map(s => s.trim()).filter(Boolean),
      steps: steps.map(s => ({ instruction: s.instruction, exitCondition: s.exitCondition || undefined })),
    };
    const url = editingId
      ? `/api/admin/characters/${charId}/methodologies/${editingId}`
      : `/api/admin/characters/${charId}/methodologies`;
    const r = await fetch(url, {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json()).catch(() => null);
    setMBusy(false);
    if (r?.ok) { resetMethodForm(); load(); }
    else setMMsg(r?.error || '儲存失敗');
  }

  async function deleteMethod(mid: string, name: string) {
    if (!confirm(`確定刪除方法論「${name}」？`)) return;
    await fetch(`/api/admin/characters/${charId}/methodologies/${mid}`, { method: 'DELETE' });
    if (editingId === mid) resetMethodForm();
    load();
  }

  function setStep(i: number, patch: Partial<StepItem>) {
    setMSteps(prev => prev.map((s, j) => j === i ? { ...s, ...patch } : s));
  }

  return (
    <div>
      <div className="ax-enter" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 27, margin: 0, fontWeight: 600, letterSpacing: '-0.02em' }}>知識與方法</h1>
          <p style={{ fontSize: 14, color: 'var(--muted)', margin: '7px 0 0' }}>
            角色寫過/講過的內容（知識庫）與引導框架（方法論）。留空 = 角色照常運作。
          </p>
        </div>
        <select value={charId} onChange={e => setCharId(e.target.value)} style={selStyle}>
          <option value="">選擇角色…</option>
          {chars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {!charId ? (
        <EmptyState icon="doc" title="先選一個角色" desc="知識庫與方法論都綁角色，全用戶共享（不同於記憶——記憶綁用戶×角色）。" />
      ) : (
        <div style={{ display: 'grid', gap: 24, gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', alignItems: 'start' }}>

          {/* ══ 知識庫 ══ */}
          <Panel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16 }}>
              <Icon name="doc" size={18} style={{ color: 'var(--accent)' }} />
              <h2 style={{ fontSize: 17, margin: 0, fontWeight: 600 }}>知識庫（著作層）</h2>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>對話時依語義檢索，撈不到就不注入</span>
            </div>

            {loading ? <p style={{ color: 'var(--muted)', fontSize: 14 }}>載入中…</p> : kdocs.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: 14, margin: '4px 0 18px' }}>尚無知識文件。</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                {kdocs.map(d => {
                  const a = authorityMeta(d.authority);
                  return (
                    <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel-2)' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, display: 'flex', gap: 8, alignItems: 'center' }}>
                          <Tag color={a.color}>{a.label}</Tag>
                          <span>{docTypeLabel(d.docType)}</span>
                          <span>{d.chunkCount} 塊</span>
                          <span>{fmt(d.createdAt)}</span>
                          {d.sourceRef && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{d.sourceRef}</span>}
                        </div>
                      </div>
                      <button onClick={() => deleteKnowledge(d.id, d.title)} title="刪除"
                        style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }}>
                        <Icon name="close" size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>新增知識文件</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 130px', gap: 10 }}>
                <Field label="標題"><TextInput value={kTitle} onChange={e => setKTitle(e.target.value)} placeholder="書名 / 文章名" /></Field>
                <Field label="類型">
                  <select value={kType} onChange={e => setKType(e.target.value)} style={{ ...selStyle, width: '100%' }}>
                    {DOC_TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
                  </select>
                </Field>
                <Field label="權威度" hint="本人原話最高">
                  <select value={kAuth} onChange={e => setKAuth(e.target.value)} style={{ ...selStyle, width: '100%' }}>
                    {AUTHORITIES.map(a => <option key={a.v} value={a.v}>{a.label}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="出處（選填）"><TextInput value={kRef} onChange={e => setKRef(e.target.value)} placeholder="版次 / URL / 章節說明" /></Field>
              <Field label="內容" hint="貼全文，系統自動切塊＋向量化；單次上限 20 萬字">
                <textarea value={kContent} onChange={e => setKContent(e.target.value)} style={taStyle} rows={7}
                  placeholder="貼上這位角色寫過/講過的原文…" />
              </Field>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <GlowButton onClick={submitKnowledge} disabled={kBusy}>
                  <Icon name="plus" size={15} />{kBusy ? '入庫中…' : '入庫'}
                </GlowButton>
                {kMsg && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{kMsg}</span>}
              </div>
            </div>
          </Panel>

          {/* ══ 方法論 ══ */}
          <Panel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16 }}>
              <Icon name="brain" size={18} style={{ color: 'var(--accent)' }} />
              <h2 style={{ fontSize: 17, margin: 0, fontWeight: 600 }}>方法論（引導框架）</h2>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>觸發匹配才遞招，進入後照步驟走</span>
            </div>

            {loading ? <p style={{ color: 'var(--muted)', fontSize: 14 }}>載入中…</p> : methods.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: 14, margin: '4px 0 18px' }}>尚無方法論。</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                {methods.map(m => (
                  <div key={m.id} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel-2)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{m.name}<span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 8, fontSize: 12.5 }}>{m.steps.length} 步</span></div>
                        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>{m.purpose}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>觸發：{m.triggerDesc}</div>
                      </div>
                      <button onClick={() => editMethod(m)} title="編輯"
                        style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }}>
                        <Icon name="edit" size={15} />
                      </button>
                      <button onClick={() => deleteMethod(m.id, m.name)} title="刪除"
                        style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }}>
                        <Icon name="close" size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{editingId ? '編輯方法論' : '新增方法論'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="名稱"><TextInput value={mName} onChange={e => setMName(e.target.value)} placeholder="例：目標釐清五問" /></Field>
                <Field label="目的"><TextInput value={mPurpose} onChange={e => setMPurpose(e.target.value)} placeholder="這套方法解決什麼問題" /></Field>
              </div>
              <Field label="觸發描述" hint="用戶說出什麼樣的話時該用這招——選招靠這句話的語義">
                <TextInput value={mTrigger} onChange={e => setMTrigger(e.target.value)} placeholder="例：用戶對未來方向迷惘、說不清楚自己要什麼" />
              </Field>
              <Field label="使用前提（選填，一行一條）">
                <textarea value={mPre} onChange={e => setMPre(e.target.value)} style={{ ...taStyle, minHeight: 54 }} rows={2}
                  placeholder="例：用戶需先陳述目標" />
              </Field>
              <Field label="步驟（照順序走，不跳步）">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {mSteps.map((s, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '24px 1fr 1fr 30px', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'right' }}>{i + 1}.</span>
                      <TextInput value={s.instruction} onChange={e => setStep(i, { instruction: e.target.value })} placeholder="這一步做什麼" />
                      <TextInput value={s.exitCondition} onChange={e => setStep(i, { exitCondition: e.target.value })} placeholder="完成判準（選填）" />
                      <button onClick={() => setMSteps(prev => prev.length > 1 ? prev.filter((_, j) => j !== i) : prev)}
                        style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4 }} title="移除">
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => setMSteps(prev => [...prev, { instruction: '', exitCondition: '' }])}
                    style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1px dashed var(--border)', borderRadius: 7, padding: '7px 12px', color: 'var(--muted)', fontSize: 13, cursor: 'pointer' }}>
                    <Icon name="plus" size={13} />加一步
                  </button>
                </div>
              </Field>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <GlowButton onClick={submitMethod} disabled={mBusy}>
                  <Icon name={editingId ? 'check' : 'plus'} size={15} />{mBusy ? '儲存中…' : editingId ? '儲存變更' : '新增'}
                </GlowButton>
                {editingId && (
                  <button onClick={resetMethodForm} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 13.5, cursor: 'pointer' }}>
                    取消編輯
                  </button>
                )}
                {mMsg && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{mMsg}</span>}
              </div>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
