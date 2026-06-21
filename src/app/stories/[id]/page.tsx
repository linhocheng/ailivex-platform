'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Wordmark, Icon, Dot, Typing, Ambient } from '@/app/_components/ui';
import { LogoutButton } from '@/app/_components/LogoutButton';

interface Card {
  id: string;
  order: number;
  intent: string;
  cardText: string;
  cardType: string;
  status: string;
  imageUrl: string;
  error: string;
  createdAt: number;
}
interface StoryDetail {
  id: string;
  intent: string;
  characterId: string;
  status: string;
  storyText: string;
  error: string;
  createdAt: number;
  cards: Card[];
}

const CARD_TYPE_LABEL: Record<string, string> = {
  realistic_photo: '寫實照片',
  infographic: '資訊圖表',
};
const CARD_TYPE_COLOR: Record<string, string> = {
  realistic_photo: '#6b9e7a',
  infographic: '#8c7ec2',
};

function fmt(ms: number) {
  return ms ? new Date(ms).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

function PhaseStep({ label, done, active, waiting }: { label: string; done: boolean; active: boolean; waiting: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 7,
      background: done ? 'rgba(107,158,122,0.12)' : active ? 'rgba(194,149,78,0.12)' : 'rgba(60,52,40,0.04)',
      border: `1px solid ${done ? 'rgba(107,158,122,0.3)' : active ? 'rgba(194,149,78,0.3)' : 'var(--border)'}`,
      color: done ? '#6b9e7a' : active ? '#c2954e' : 'var(--muted)', fontSize: 13 }}>
      {active && <Typing />}
      {done && <Dot color="#6b9e7a" size={6} />}
      {waiting && <Dot color="rgba(255,255,255,0.2)" size={6} />}
      {label}
    </div>
  );
}

function CardRow({ card, onEdit, onDelete, onRegenerate, lightboxImg, setLightboxImg }: {
  card: Card;
  onEdit: (id: string, field: string, val: string) => Promise<void>;
  onDelete: (id: string) => void;
  onRegenerate: (cardId: string) => void;
  lightboxImg: string | null;
  setLightboxImg: (url: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(card.cardText);
  const [draftType, setDraftType] = useState(card.cardType);
  const [saving, setSaving] = useState(false);
  const inProgress = card.status === 'pending' || card.status === 'running';

  async function save() {
    setSaving(true);
    await onEdit(card.id, 'cardText', draftText);
    await onEdit(card.id, 'cardType', draftType);
    setSaving(false);
    setEditing(false);
  }

  return (
    <div className="ax-enter" style={{ borderRadius: 10, background: 'var(--panel)', border: '1px solid var(--border)', overflow: 'hidden' }}>
      {/* 頂列 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
        borderBottom: (card.imageUrl || editing) ? '1px solid var(--border)' : 'none' }}>
        <div style={{ width: 28, height: 28, borderRadius: 6, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: 'rgba(60,52,40,0.08)', fontSize: 12.5, fontWeight: 700, color: 'var(--muted)' }}>
          {card.order}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{card.intent || `圖卡 ${card.order}`}</div>
          {!editing && (
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{card.cardText}</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {/* 類型徽章 */}
          <span style={{ fontSize: 11.5, padding: '3px 8px', borderRadius: 5, fontWeight: 500,
            background: `rgba(${card.cardType === 'realistic_photo' ? '107,158,122' : '140,126,194'},0.12)`,
            color: CARD_TYPE_COLOR[card.cardType] || 'var(--muted)' }}>
            {CARD_TYPE_LABEL[card.cardType] || card.cardType}
          </span>
          {/* 狀態 */}
          {inProgress && <Typing />}
          {card.status === 'done' && <Dot color="#6b9e7a" size={7} />}
          {card.status === 'failed' && <Dot color="#b5654a" size={7} />}
          {card.status === 'scripted' && <Dot color="rgba(255,255,255,0.25)" size={7} />}
          {/* 操作 */}
          {!editing && (
            <button onClick={() => setEditing(true)} title="編輯"
              style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 6,
                background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--muted)' }}>
              <Icon name="edit" size={14} />
            </button>
          )}
          {(card.status === 'done' || card.status === 'failed') && (
            <button onClick={() => onRegenerate(card.id)} title="重新生成"
              style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 6,
                background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--muted)' }}>
              <Icon name="refresh" size={14} />
            </button>
          )}
          <button onClick={() => onDelete(card.id)} title="刪除"
            style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 6,
              background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--muted)' }}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>

      {/* 編輯區 */}
      {editing && (
        <div style={{ padding: '14px 16px', borderBottom: card.imageUrl ? '1px solid var(--border)' : 'none' }}>
          <textarea value={draftText} onChange={e => setDraftText(e.target.value)} rows={3}
            style={{ width: '100%', resize: 'vertical', fontSize: 13.5, lineHeight: 1.6,
              background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', borderRadius: 7,
              padding: '9px 12px', color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: 10 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <select value={draftType} onChange={e => setDraftType(e.target.value)}
              style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--panel)', color: 'var(--text)', cursor: 'pointer' }}>
              <option value="realistic_photo">寫實照片</option>
              <option value="infographic">資訊圖表</option>
            </select>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button onClick={() => { setEditing(false); setDraftText(card.cardText); setDraftType(card.cardType); }}
                style={{ fontSize: 13, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}>取消</button>
              <button onClick={save} disabled={saving}
                style={{ fontSize: 13, padding: '6px 14px', borderRadius: 6, border: 'none',
                  background: 'var(--accent)', color: '#fff', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 500 }}>
                {saving ? '儲存中…' : '儲存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 圖片 */}
      {card.imageUrl && (
        <div onClick={() => setLightboxImg(card.imageUrl)} style={{ cursor: 'pointer', overflow: 'hidden', maxHeight: 340 }}>
          <img src={card.imageUrl} alt={card.intent}
            style={{ width: '100%', objectFit: 'cover', display: 'block', transition: 'transform .3s' }}
            onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.02)')}
            onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')} />
        </div>
      )}
      {inProgress && !card.imageUrl && (
        <div style={{ padding: '20px 16px', display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)', fontSize: 13 }}>
          <Typing />生成圖片中…
        </div>
      )}
      {card.status === 'failed' && (
        <div style={{ padding: '12px 16px', fontSize: 12.5, color: '#b5654a' }}>{card.error || '圖片生成失敗'}</div>
      )}
    </div>
  );
}

export default function StoryDetailPage() {
  const params = useParams();
  const router = useRouter();
  const storyId = params.id as string;

  const [story, setStory] = useState<StoryDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [storyDraft, setStoryDraft] = useState('');
  const [savingStory, setSavingStory] = useState(false);
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [genImgLoading, setGenImgLoading] = useState(false);
  const [addCard, setAddCard] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addText, setAddText] = useState('');
  const [addType, setAddType] = useState('realistic_photo');
  const [addLoading, setAddLoading] = useState(false);

  const phaseATriggered = useRef(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/stories/${storyId}`).then(r => r.json()).catch(() => null);
    if (r?.id) {
      setStory(r);
      if (!storyDraft) setStoryDraft(r.storyText || '');
      setLoaded(true);
      // pending + 沒有故事文字 → 自動觸發 Phase A（enqueueStoryDraftJob 可能沒成功）
      // Phase B 由 generate-story 的 after() 直接串聯，不在 client 觸發（避免重複）
      if (r.status === 'pending' && !r.storyText && !phaseATriggered.current) {
        phaseATriggered.current = true;
        fetch(`/api/tasks/${storyId}/generate-story`, { method: 'POST' }).catch(() => {});
      }
    } else if (r?.error === 'not_found') {
      router.push('/stories');
    }
  }, [storyId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!story) return;
    const needsPoll = story.status === 'pending' || story.status === 'scripting'
      || story.cards.some(c => c.status === 'pending' || c.status === 'running');
    if (!needsPoll) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [story, load]);

  async function saveStory() {
    if (!storyDraft.trim()) return;
    setSavingStory(true);
    await fetch(`/api/stories/${storyId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyText: storyDraft }),
    }).catch(() => {});
    setSavingStory(false);
  }

  async function regenStory() {
    if (!confirm('重新生成劇情會覆蓋現有文字，確定嗎？')) return;
    await fetch(`/api/tasks/${storyId}/generate-story`, { method: 'POST' });
    load();
  }

  async function regenScripts() {
    if (!confirm('重新分析腳本會覆蓋現有圖卡文字，確定嗎？')) return;
    await fetch(`/api/tasks/${storyId}/generate-scripts`, { method: 'POST' });
    load();
  }

  async function generateImages() {
    setGenImgLoading(true);
    await fetch(`/api/tasks/${storyId}/generate-images`, { method: 'POST' });
    setGenImgLoading(false);
    load();
  }

  async function regenerateCard(cardId: string) {
    await fetch(`/api/tasks/${storyId}/generate-images`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId }),
    });
    load();
  }

  async function editCard(id: string, field: string, val: string) {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: val }),
    }).catch(() => {});
    await load();
  }

  async function deleteCard(id: string) {
    if (!confirm('確定刪除這張圖卡？')) return;
    await fetch(`/api/gallery/${id}`, { method: 'DELETE' }).catch(() => {});
    load();
  }

  async function addNewCard() {
    if (!addText.trim()) return;
    setAddLoading(true);
    await fetch(`/api/tasks/${storyId}/generate-storyboard`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addOne: true, prompt: addText, intent: addTitle }),
    }).catch(() => {});
    setAddTitle(''); setAddText(''); setAddType('realistic_photo'); setAddCard(false); setAddLoading(false);
    load();
  }

  if (!loaded) return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <Typing />
    </div>
  );

  if (!story) return null;

  const phaseA_done = ['scripting', 'ready', 'done'].includes(story.status);
  const phaseA_active = story.status === 'pending';
  const phaseB_done = ['ready', 'done'].includes(story.status) && story.cards.length > 0;
  const phaseB_active = story.status === 'scripting';
  const imgActive = story.cards.filter(c => c.status === 'pending' || c.status === 'running').length;
  const imgDone = story.cards.filter(c => c.status === 'done').length;
  const scripted = story.cards.filter(c => c.status === 'scripted' || c.status === 'failed').length;

  return (
    <>
      <Ambient />
      {lightboxImg && (
        <div onClick={() => setLightboxImg(null)} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center',
          background: 'rgba(20,16,12,0.78)', padding: 'clamp(16px,5vw,48px)', backdropFilter: 'blur(4px)' }}>
          <img src={lightboxImg} onClick={e => e.stopPropagation()}
            style={{ maxWidth: '100%', maxHeight: '88vh', objectFit: 'contain', borderRadius: 10,
              boxShadow: '0 24px 60px rgba(0,0,0,0.4)' }} />
        </div>
      )}
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px clamp(16px,4vw,26px)', borderBottom: '1px solid var(--border)',
          position: 'relative', zIndex: 5, background: 'var(--bg)' }}>
          <Link href="/lobby"><Wordmark size={19} /></Link>
          <nav style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Link href="/stories" style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
              color: 'var(--muted)', padding: '9px 13px', borderRadius: 6, fontSize: 14, fontWeight: 500 }}>
              <Icon name="chevron-left" size={15} />故事板
            </Link>
            <LogoutButton style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(60,52,40,0.045)',
              border: '1px solid var(--border)', borderRadius: 6, padding: '8px 14px', fontSize: 13,
              fontWeight: 500, color: 'var(--text)', cursor: 'pointer' }}>
              <Icon name="logout" size={16} />登出
            </LogoutButton>
          </nav>
        </header>

        <main style={{ flex: 1, padding: '36px clamp(20px,5vw,64px) 80px' }}>
          <div style={{ maxWidth: 780, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 40 }}>

            {/* 標題 + 進度 */}
            <div className="ax-enter">
              <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 16px', letterSpacing: '-0.02em' }}>
                {story.intent || '故事板'}
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <PhaseStep label="劇情生成" done={phaseA_done} active={phaseA_active} waiting={!phaseA_done && !phaseA_active} />
                <Icon name="chevron-right" size={14} style={{ color: 'var(--border)' }} />
                <PhaseStep label="腳本分析" done={phaseB_done} active={phaseB_active} waiting={!phaseB_done && !phaseB_active} />
                <Icon name="chevron-right" size={14} style={{ color: 'var(--border)' }} />
                <PhaseStep label={`圖卡生成${story.cards.length > 0 ? ` ${imgDone}/${story.cards.length}` : ''}`}
                  done={imgDone > 0 && imgDone === story.cards.length && story.cards.length > 0}
                  active={imgActive > 0} waiting={imgActive === 0 && imgDone < story.cards.length} />
              </div>
            </div>

            {/* Section A — 故事劇情 */}
            {(phaseA_done || phaseA_active) && (
              <section className="ax-enter">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', letterSpacing: '0.04em' }}>故事劇情</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {phaseA_done && (
                      <button onClick={regenStory} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                        fontSize: 12.5, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)',
                        background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}>
                        <Icon name="refresh" size={13} />重新生成
                      </button>
                    )}
                    {phaseA_done && (
                      <button onClick={saveStory} disabled={savingStory} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                        fontSize: 12.5, padding: '5px 10px', borderRadius: 6, border: 'none',
                        background: 'var(--accent)', color: '#fff', cursor: savingStory ? 'not-allowed' : 'pointer', fontWeight: 500 }}>
                        {savingStory ? '儲存中…' : '儲存'}
                      </button>
                    )}
                  </div>
                </div>
                {phaseA_active ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px', borderRadius: 10,
                    background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--muted)', fontSize: 13 }}>
                    <Typing />生成故事劇情中…
                  </div>
                ) : (
                  <textarea value={storyDraft} onChange={e => setStoryDraft(e.target.value)} rows={14}
                    style={{ width: '100%', resize: 'vertical', fontSize: 14, lineHeight: 1.8,
                      background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10,
                      padding: '16px 18px', color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                )}
              </section>
            )}

            {/* Section B + C — 圖卡腳本與圖片 */}
            {(phaseB_done || phaseB_active || story.cards.length > 0) && (
              <section className="ax-enter">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', letterSpacing: '0.04em' }}>
                    圖卡腳本 {story.cards.length > 0 && `· ${story.cards.length} 張`}
                  </div>
                  {phaseB_done && (
                    <button onClick={regenScripts} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                      fontSize: 12.5, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)',
                      background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}>
                      <Icon name="refresh" size={13} />重新分析
                    </button>
                  )}
                </div>

                {phaseB_active && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px', borderRadius: 10,
                    background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--muted)', fontSize: 13, marginBottom: 14 }}>
                    <Typing />分析故事腳本中…
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {story.cards.map(card => (
                    <CardRow key={card.id} card={card}
                      onEdit={editCard} onDelete={deleteCard} onRegenerate={regenerateCard}
                      lightboxImg={lightboxImg} setLightboxImg={setLightboxImg} />
                  ))}
                </div>

                {/* 加一張 */}
                {phaseB_done && (
                  addCard ? (
                    <div style={{ marginTop: 12, padding: '16px', borderRadius: 10, background: 'var(--panel)', border: '1px solid var(--border)' }}>
                      <input value={addTitle} onChange={e => setAddTitle(e.target.value)}
                        placeholder="圖卡標題（選填）"
                        style={{ width: '100%', fontSize: 13.5, padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)',
                          background: 'rgba(60,52,40,0.04)', color: 'var(--text)', fontFamily: 'inherit', marginBottom: 8, boxSizing: 'border-box' }} />
                      <textarea value={addText} onChange={e => setAddText(e.target.value)} rows={3}
                        placeholder="描述這張圖卡要呈現的畫面或資訊…"
                        style={{ width: '100%', resize: 'vertical', fontSize: 13.5, lineHeight: 1.6,
                          background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', borderRadius: 7,
                          padding: '9px 12px', color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: 10 }} />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <select value={addType} onChange={e => setAddType(e.target.value)}
                          style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)',
                            background: 'var(--panel)', color: 'var(--text)', cursor: 'pointer' }}>
                          <option value="realistic_photo">寫實照片</option>
                          <option value="infographic">資訊圖表</option>
                        </select>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                          <button onClick={() => setAddCard(false)} style={{ fontSize: 13, padding: '6px 12px', borderRadius: 6,
                            border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}>
                            取消
                          </button>
                          <button onClick={addNewCard} disabled={addLoading} style={{ fontSize: 13, padding: '6px 14px', borderRadius: 6,
                            border: 'none', background: 'var(--accent)', color: '#fff', cursor: addLoading ? 'not-allowed' : 'pointer', fontWeight: 500 }}>
                            {addLoading ? '加入中…' : '加入'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setAddCard(true)} style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6,
                      fontSize: 13, color: 'var(--muted)', background: 'transparent', border: '1px dashed var(--border)',
                      borderRadius: 8, padding: '10px 16px', cursor: 'pointer', width: '100%', justifyContent: 'center' }}>
                      <Icon name="plus" size={14} />加一張圖卡
                    </button>
                  )
                )}

                {/* 生成圖卡大按鈕 */}
                {scripted > 0 && (
                  <button onClick={generateImages} disabled={genImgLoading}
                    style={{ marginTop: 16, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      fontSize: 15, fontWeight: 600, padding: '14px', borderRadius: 10, border: 'none',
                      background: 'var(--accent)', color: '#fff', cursor: genImgLoading ? 'not-allowed' : 'pointer',
                      opacity: genImgLoading ? 0.7 : 1 }}>
                    <Icon name="image" size={18} />
                    {genImgLoading ? '排隊中…' : `生成圖卡（${scripted} 張待生成）`}
                  </button>
                )}
              </section>
            )}

            {story.status === 'failed' && (
              <div style={{ padding: '16px', borderRadius: 10, background: 'rgba(181,101,74,0.08)',
                border: '1px solid rgba(181,101,74,0.28)', color: '#b5654a', fontSize: 13 }}>
                {story.error || '生成失敗'}
                <button onClick={regenStory} style={{ marginLeft: 16, fontSize: 13, padding: '4px 10px', borderRadius: 6,
                  border: '1px solid rgba(181,101,74,0.4)', background: 'transparent', color: '#b5654a', cursor: 'pointer' }}>
                  重試
                </button>
              </div>
            )}

          </div>
        </main>
      </div>
    </>
  );
}
