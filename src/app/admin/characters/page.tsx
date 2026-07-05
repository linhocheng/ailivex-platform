'use client';

import { useEffect, useState, useRef } from 'react';
import { Avatar, Icon, Dot, Field, TextInput, GlowButton } from '@/app/_components/ui';

interface VoiceSettings { speed?: number; pitch?: number; vol?: number; emotion?: string; }
interface ConvSettings { responseSpeed?: number; interruptSensitivity?: number; imThreshold?: number; interruptThreshold?: number; temperature?: number; }
interface Char {
  id: string; name: string; avatarUrl: string; status: string;
  hasSoulCore: boolean; voiceIdMinimax: string; voiceSettings: VoiceSettings;
}
interface BrandLayout { id: string; name: string; imageUrl: string; description: string; isDefault: boolean; }
interface BrandProduct { id: string; name: string; imageUrl: string; tags: string[]; }
type TaskCapability = 'image_generation' | 'audio_generation' | 'script_draft' | 'story_draft' | 'writing' | 'web_search' | 'video_generation';
const ALL_CAPABILITIES: { value: TaskCapability; label: string }[] = [
  { value: 'image_generation', label: '製圖' },
  { value: 'audio_generation', label: '生音檔' },
  { value: 'script_draft', label: '腳本草稿' },
  { value: 'story_draft', label: '故事圖卡' },
  { value: 'writing', label: '寫文件' },
  { value: 'web_search', label: '網路搜尋' },
  { value: 'video_generation', label: 'HeyGen 分身影片' },
];

type EditState = {
  id: string; name: string; soul: string; soulCore: string;
  voiceId: string; voiceSettings: VoiceSettings; convSettings: ConvSettings;
  aliases: string[];
  capabilities: TaskCapability[];
  imageStyle: string;
  heygenAvatarId: string;
  heygenAvatarUrl: string;
  avatar: { b64: string; type: string } | null;
};

const EMOTIONS = [
  { value:'neutral', label:'neutral（中性）' },
  { value:'happy',   label:'happy（開心）' },
  { value:'sad',     label:'sad（哀傷）' },
  { value:'angry',   label:'angry（憤怒）' },
  { value:'fearful', label:'fearful（恐懼）' },
  { value:'surprised', label:'surprised（驚訝）' },
  { value:'disgusted', label:'disgusted（厭惡）' },
];

// 頭像前端壓縮：canvas 縮到 512px JPEG（顯示最大 120px，綽綽有餘）——根治 >3.4MB 撞 Vercel 4.5MB 的 413
function compressImage(file: File): Promise<{ b64: string; type: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 512;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({ b64: canvas.toDataURL('image/jpeg', 0.85), type: 'image/jpeg' });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('圖片讀取失敗')); };
    img.src = url;
  });
}

const inputBase: React.CSSProperties = {
  background:'var(--panel-2)', border:'1px solid var(--border)', borderRadius:8,
  padding:'10px 12px', color:'var(--text)', fontSize:14, outline:'none', display:'block', width:'100%', boxSizing:'border-box',
};

function Slider({ label, hint, value, min, max, step, defaultVal, onChange }: {
  label: string; hint?: string; value: number; min: number; max: number;
  step: number; defaultVal: number; onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
        <label style={{ fontSize:12, color:'var(--muted)' }}>
          {label}{hint && <span style={{ fontSize:11, marginLeft:6, opacity:0.7 }}>{hint}</span>}
        </label>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <span style={{ fontSize:12, fontFamily:'monospace', background:'var(--panel-2)', padding:'1px 7px', borderRadius:5 }}>
            {value.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0)}
          </span>
          <button onClick={() => onChange(defaultVal)} style={{ background:'none', border:'none', color:'var(--muted)', fontSize:11, cursor:'pointer', padding:0 }}>reset</button>
        </div>
      </div>
      <input type="range" value={value} min={min} max={max} step={step}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width:'100%', accentColor:'var(--accent)', cursor:'pointer' }} />
    </div>
  );
}

function VoicePanel({ vs, onChange }: { vs: VoiceSettings; onChange: (v: VoiceSettings) => void }) {
  const s = (k: keyof VoiceSettings, v: number | string) => onChange({ ...vs, [k]:v });
  return (
    <div style={{ borderTop:'1px solid var(--border)', paddingTop:14, marginTop:4 }}>
      <div style={{ fontSize:12, fontWeight:600, color:'var(--muted)', marginBottom:12 }}>聲音微調（MiniMax）</div>
      <Slider label="Speed 語速" hint="1.0=正常 (0.5–2.0)" value={vs.speed??1.0} min={0.5} max={2.0} step={0.05} defaultVal={1.0} onChange={v=>s('speed',v)} />
      <Slider label="Pitch 音高" hint="0=正常 (−12~+12)" value={vs.pitch??0} min={-12} max={12} step={1} defaultVal={0} onChange={v=>s('pitch',v)} />
      <Slider label="Volume 音量" hint="1.0=正常 (0.1–3.0)" value={vs.vol??1.0} min={0.1} max={3.0} step={0.1} defaultVal={1.0} onChange={v=>s('vol',v)} />
      <div>
        <label style={{ fontSize:12, color:'var(--muted)' }}>Emotion 情緒</label>
        <select value={vs.emotion??'neutral'} onChange={e=>s('emotion',e.target.value)}
          style={{ ...inputBase, marginTop:4 }}>
          {EMOTIONS.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
        </select>
      </div>
    </div>
  );
}

function ConvPanel({ cs, onChange }: { cs: ConvSettings; onChange: (v: ConvSettings) => void }) {
  const s = (k: keyof ConvSettings, v: number) => onChange({ ...cs, [k]: v });
  return (
    <div style={{ borderTop:'1px solid var(--border)', paddingTop:14, marginTop:4 }}>
      <div style={{ fontSize:12, fontWeight:600, color:'var(--muted)', marginBottom:4 }}>對話手感（即時語音）</div>
      <div style={{ fontSize:11, color:'var(--muted)', opacity:0.7, marginBottom:12 }}>都預設 3=現行行為。改了即時生效，不用重部署。</div>
      <Slider label="接話速度" hint="1=慢條斯理 … 5=秒回" value={cs.responseSpeed??3} min={1} max={5} step={1} defaultVal={3} onChange={v=>s('responseSpeed',v)} />
      <Slider label="被打斷敏感度" hint="1=講完才停 … 5=一出聲就停" value={cs.interruptSensitivity??3} min={1} max={5} step={1} defaultVal={3} onChange={v=>s('interruptSensitivity',v)} />
      <Slider label="主動程度" hint="2.0版：1=安靜 … 5=冷場就開口" value={cs.imThreshold??3} min={1} max={5} step={1} defaultVal={3} onChange={v=>s('imThreshold',v)} />
      <Slider label="搶話程度" hint="群聊用：1=有禮貌 … 5=愛插話" value={cs.interruptThreshold??3} min={1} max={5} step={1} defaultVal={3} onChange={v=>s('interruptThreshold',v)} />
      <Slider label="溫度（真實度）" hint="低=收斂不演 高=多變 (0.1–1.0，2.0版生效)" value={cs.temperature??0.4} min={0.1} max={1.0} step={0.05} defaultVal={0.4} onChange={v=>s('temperature',v)} />
    </div>
  );
}

function HeygenAvatarUpload({ charId, currentId, currentUrl, onUploaded }: {
  charId: string;
  currentId: string;
  currentUrl: string;
  onUploaded: (id: string, url: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const r = await fetch(`/api/admin/characters/${charId}/heygen-avatar`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'image/jpeg' },
      body: file,
    }).then(r => r.json()).catch(() => null);
    setUploading(false);
    if (r?.talkingPhotoId) onUploaded(r.talkingPhotoId, r.previewUrl || '');
    else alert('上傳失敗，請稍後再試。');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {currentUrl && (
        <img
          src={currentUrl}
          alt="HeyGen 分身照"
          style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }}
        />
      )}
      {currentId && (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          ID: <code style={{ fontSize: 11 }}>{currentId}</code>
        </div>
      )}
      <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFile} />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        style={{ ...inputBase, cursor: uploading ? 'not-allowed' : 'pointer', textAlign: 'center', color: 'var(--muted)' }}
      >
        {uploading ? '上傳中…' : currentId ? '重新上傳照片' : '上傳分身照片'}
      </button>
    </div>
  );
}

export default function AdminCharacters() {
  const [list, setList] = useState<Char[]>([]);
  const [name, setName] = useState('');
  const [soul, setSoul] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({ emotion: 'neutral' });
  const [convSettings, setConvSettings] = useState<ConvSettings>({});
  const [soulCore, setSoulCore] = useState('');
  const [createAliases, setCreateAliases] = useState('');
  const [createCaps, setCreateCaps] = useState<TaskCapability[]>([]);
  const [avatar, setAvatar] = useState<{ b64: string; type: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [auditionText, setAuditionText] = useState('你好，我是這個角色的聲音，請多指教。');
  const [editing, setEditing] = useState<EditState | null>(null);
  // 預載狀態：完整資料抓回來前禁止存檔（否則空殼 aliases/capabilities 會把 DB 洗空）
  const [editLoading, setEditLoading] = useState(false);
  const [editMsg, setEditMsg] = useState('');
  const [editBusy, setEditBusy] = useState('');
  const [editAuditionText, setEditAuditionText] = useState('你好，我是這個角色的聲音，請多指教。');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [testPlaying, setTestPlaying] = useState(false);
  const [editTestPlaying, setEditTestPlaying] = useState(false);

  // Brand Assets
  const [baCharId, setBaCharId] = useState<string | null>(null);
  const [baCharName, setBaCharName] = useState('');
  const [layouts, setLayouts] = useState<BrandLayout[]>([]);
  const [products, setProducts] = useState<BrandProduct[]>([]);
  const [baMsg, setBaMsg] = useState('');
  const [baUploading, setBaUploading] = useState('');
  const layoutFileRef = useRef<HTMLInputElement>(null);
  const [layoutForm, setLayoutForm] = useState({ name: '', description: '', isDefault: false });
  const [layoutFile, setLayoutFile] = useState<File | null>(null);
  const [layoutPreview, setLayoutPreview] = useState<string | null>(null);
  const [baDeleteConfirmId, setBaDeleteConfirmId] = useState<string | null>(null);
  const [charDeleteConfirmId, setCharDeleteConfirmId] = useState<string | null>(null);

  // Product bulk upload queue
  type QueueItem = { id: string; file: File; status: 'queued' | 'uploading' | 'done' | 'error'; previewUrl: string; name: string };
  const [productQueue, setProductQueue] = useState<QueueItem[]>([]);
  const [isDraggingProduct, setIsDraggingProduct] = useState(false);
  const productDropRef = useRef<HTMLInputElement>(null);

  async function load() {
    const r = await fetch('/api/admin/characters').then(r => r.json()).catch(() => ({ characters:[] }));
    setList(r.characters || []);
  }
  useEffect(() => { load(); }, []);

  async function loadBrandAssets(charId: string) {
    const [lr, pr] = await Promise.all([
      fetch(`/api/admin/characters/${charId}/brand-layouts`).then(r => r.json()).catch(() => ({ layouts: [] })),
      fetch(`/api/admin/characters/${charId}/brand-products`).then(r => r.json()).catch(() => ({ products: [] })),
    ]);
    setLayouts(lr.layouts || []);
    setProducts(pr.products || []);
  }

  async function openBrandAssets(charId: string, charName: string) {
    setBaCharId(charId); setBaCharName(charName); setBaMsg('');
    setLayoutForm({ name: '', description: '', isDefault: false });
    setProductQueue([]);
    await loadBrandAssets(charId);
  }

  async function uploadLayout(charId: string, file: File) {
    if (!layoutForm.name.trim()) { setBaMsg('請填寫 Layout 名稱'); return; }
    setBaUploading('layout');
    const r = await fetch(`/api/admin/characters/${charId}/brand-layouts`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'image/jpeg',
        'x-name': encodeURIComponent(layoutForm.name.trim()),
        'x-description': encodeURIComponent(layoutForm.description.trim()),
        'x-is-default': layoutForm.isDefault ? 'true' : 'false',
      },
      body: file,
    }).then(r => r.json()).catch(() => null);
    setBaUploading('');
    if (r?.id) {
      setBaMsg('');
      setLayoutForm({ name: '', description: '', isDefault: false });
      setLayoutFile(null); setLayoutPreview(null);
      if (layoutFileRef.current) layoutFileRef.current.value = '';
      await loadBrandAssets(charId);
    } else setBaMsg(r?.error || '上傳失敗');
  }

  async function setDefaultLayout(charId: string, layoutId: string) {
    const r = await fetch(`/api/admin/characters/${charId}/brand-layouts/${layoutId}`, { method: 'PATCH' })
      .then(r => r.json()).catch(() => null);
    if (r?.error) { setBaMsg(r.error); return; }
    await loadBrandAssets(charId);
  }

  async function deleteLayout(charId: string, layoutId: string) {
    const r = await fetch(`/api/admin/characters/${charId}/brand-layouts/${layoutId}`, { method: 'DELETE' })
      .then(r => r.json()).catch(() => null);
    if (r?.error) { setBaMsg(r.error); return; }
    await loadBrandAssets(charId);
  }

  async function uploadQueueItem(queueId: string, file: File, name: string, charId: string): Promise<void> {
    setProductQueue(q => q.map(i => i.id === queueId ? { ...i, status: 'uploading' } : i));
    const r = await fetch(`/api/admin/characters/${charId}/brand-products`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'image/jpeg',
        'x-name': encodeURIComponent(name),
      },
      body: file,
    }).then(res => res.json()).catch(() => null);
    setProductQueue(q => q.map(i => i.id === queueId ? { ...i, status: r?.id ? 'done' : 'error' } : i));
  }

  async function addProductFiles(files: FileList | File[], charId: string) {
    if (!charId) return;
    const arr = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!arr.length) return;
    const items: QueueItem[] = arr.map(f => ({
      id: Math.random().toString(36).slice(2),
      file: f,
      status: 'queued' as const,
      previewUrl: URL.createObjectURL(f),
      name: f.name.replace(/\.[^.]+$/, ''),
    }));
    setProductQueue(q => [...q, ...items]);
    await Promise.allSettled(items.map(item => uploadQueueItem(item.id, item.file, item.name, charId)));
    await loadBrandAssets(charId);
  }

  async function deleteProduct(charId: string, productId: string) {
    const r = await fetch(`/api/admin/characters/${charId}/brand-products/${productId}`, { method: 'DELETE' })
      .then(r => r.json()).catch(() => null);
    if (r?.error) { setBaMsg(r.error); return; }
    await loadBrandAssets(charId);
  }

  function onAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    compressImage(f).then(setAvatar).catch(() => setMsg('圖片讀取失敗，請換一張'));
  }
  function onEditAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f || !editing) return;
    compressImage(f).then(avatar => setEditing(cur => cur ? { ...cur, avatar } : cur))
      .catch(() => setEditMsg('圖片讀取失敗，請換一張'));
  }

  async function playVoice(vid: string, settings: VoiceSettings, text: string, setPlaying: (v: boolean) => void) {
    if (!vid.trim()) return;
    setPlaying(true);
    try {
      const r = await fetch('/api/tts', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ text, voiceId: vid.trim(), settings }),
      });
      if (!r.ok) { alert('試聽失敗：' + ((await r.json().catch(()=>({})))?.error||'')); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) { audioRef.current.pause(); URL.revokeObjectURL(audioRef.current.src); }
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setPlaying(false); URL.revokeObjectURL(url); };
      audio.onerror = () => setPlaying(false);
      audio.play();
    } catch(e) { alert('試聽錯誤：'+String(e)); setPlaying(false); }
  }

  async function preview() {
    setMsg(''); setBusy('preview');
    const r = await fetch('/api/admin/soul-enhance', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, soul }),
    }).then(r => r.json()).catch(() => null);
    setBusy('');
    if (r?.soulCore) setSoulCore(r.soulCore);
    else setMsg(r?.error || '提煉失敗');
  }

  async function create() {
    setMsg(''); setBusy('create');
    const resp = await fetch('/api/admin/characters', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, soul, soulCore: soulCore||undefined,
        avatarBase64:avatar?.b64, avatarContentType:avatar?.type,
        voiceIdMinimax:voiceId||undefined, voiceSettings, convSettings,
        capabilities: createCaps,
        aliases: createAliases.split('\n').map(s => s.trim()).filter(Boolean) }),
    }).catch(() => null);
    const r = resp ? await resp.json().catch(() => null) : null;
    setBusy('');
    if (r?.id) {
      setName(''); setSoul(''); setSoulCore(''); setVoiceId(''); setVoiceSettings({}); setConvSettings({}); setAvatar(null);
      setCreateAliases(''); setCreateCaps([]);
      setMsg('已建立角色'); load();
    } else setMsg(resp?.status === 413 ? '圖片過大，請換一張再試' : (r?.error || '建立失敗'));
  }

  async function saveEdit() {
    if (!editing || editLoading) return; // 完整資料未回來前不准存（防空殼洗掉欄位）
    setEditMsg(''); setEditBusy('save');
    const payload: Record<string, unknown> = { name: editing.name };
    if (editing.soul.trim()) payload.soul = editing.soul.trim();
    if (editing.soulCore.trim()) payload.soulCore = editing.soulCore.trim();
    payload.voiceIdMinimax = editing.voiceId;
    payload.voiceSettings = editing.voiceSettings;
    payload.convSettings = editing.convSettings;
    payload.aliases = editing.aliases.filter(a => a.trim());
    payload.capabilities = editing.capabilities;
    payload.imageStyle = editing.imageStyle;
    payload.heygenAvatarId = editing.heygenAvatarId;
    if (editing.avatar?.b64) { payload.avatarBase64 = editing.avatar.b64; payload.avatarContentType = editing.avatar.type; }
    const resp = await fetch(`/api/admin/characters/${editing.id}`, {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    }).catch(() => null);
    const r = resp ? await resp.json().catch(() => null) : null;
    setEditBusy('');
    if (r?.ok) { setEditing(null); load(); }
    else setEditMsg(resp?.status === 413 ? '圖片過大，請換一張再試' : (r?.error || '儲存失敗'));
  }

  async function reEnhanceEdit() {
    if (!editing) return;
    setEditMsg(''); setEditBusy('enhance');
    const r = await fetch('/api/admin/soul-enhance', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name: editing.name, soul: editing.soul }),
    }).then(r => r.json()).catch(() => null);
    setEditBusy('');
    if (r?.soulCore) setEditing({ ...editing, soulCore: r.soulCore });
    else setEditMsg(r?.error || '提煉失敗');
  }

  async function deleteChar(id: string) {
    const r = await fetch(`/api/admin/characters/${id}`, { method:'DELETE' }).then(r => r.json()).catch(() => null);
    if (r?.ok) { setCharDeleteConfirmId(null); load(); }
    else { setCharDeleteConfirmId(null); setMsg(r?.error || '刪除失敗'); }
  }

  return (
    <div>
      <div className="ax-enter" style={{ marginBottom:28 }}>
        <h1 style={{ fontSize:27, margin:0, fontWeight:600, letterSpacing:'-0.02em' }}>角色管理</h1>
        <p style={{ fontSize:14, color:'var(--muted)', margin:'7px 0 0' }}>建立與編輯 AI 角色 — 賦予它靈魂與聲音。</p>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'300px 1fr', gap:20, alignItems:'start' }} className="ax-char-grid">
        {/* Character list */}
        <div style={{ background:'var(--panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:14 }} className="ax-enter">
          <GlowButton full onClick={() => {}} style={{ marginBottom:10, opacity:0.6 }}>
            <Icon name="plus" size={16} />新增角色（見右側表單）
          </GlowButton>
          <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
            {list.map(c => (
              <div key={c.id} style={{ display:'flex', flexDirection:'column', gap:8, padding:'9px 10px', borderRadius:7,
                border:'1px solid var(--border)', background:'rgba(60,52,40,0.02)' }}>
                <div style={{ display:'flex', alignItems:'center', gap:12, minWidth:0 }}>
                  <Avatar name={c.name} avatarUrl={c.avatarUrl} size={40} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14.5, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.name}</div>
                    <div style={{ fontSize:11.5, color:'var(--muted)' }}>
                      {c.hasSoulCore ? 'soul ✓' : 'soul ✗'}
                      {c.voiceIdMinimax ? ' · 語音 ✓' : ''}
                    </div>
                  </div>
                  {c.voiceIdMinimax && <Icon name="mic" size={14} style={{ color:'var(--accent-2)', flexShrink:0 }} />}
                </div>
                <div style={{ display:'flex', gap:6, alignItems:'center', justifyContent:'flex-end', flexWrap:'wrap' }}>
                  <a href={`/chat/${c.id}`} target="_blank" rel="noopener"
                    style={{ padding:'5px 10px', borderRadius:6, border:'1px solid var(--border)',
                      background:'transparent', color:'var(--text)', fontSize:12, textDecoration:'none' }}>
                    對話
                  </a>
                  {c.voiceIdMinimax && (
                    <a href={`/realtime-v14/${c.id}`} target="_blank" rel="noopener" title="語音通話（測試）"
                      style={{ padding:'5px 8px', borderRadius:6, border:'1px solid var(--border)',
                        background:'transparent', color:'var(--accent-2)', fontSize:12, textDecoration:'none' }}>
                      語音
                    </a>
                  )}
                  <button onClick={async () => {
                    setEditMsg(''); setEditAuditionText('你好，我是這個角色的聲音，請多指教。');
                    setEditLoading(true); // 完整資料回來前擋存檔
                    setEditing({ id:c.id, name:c.name, soul:'', soulCore:'', voiceId:c.voiceIdMinimax, voiceSettings:{emotion:'neutral', ...c.voiceSettings}, convSettings:{}, aliases:[], capabilities:[], imageStyle:'', heygenAvatarId:'', heygenAvatarUrl:'', avatar:null });
                    const r = await fetch(`/api/admin/characters/${c.id}`).then(r => r.json()).catch(()=>null);
                    if (r?.id) {
                      setEditing({ id:r.id, name:r.name, soul:r.soul, soulCore:r.soulCore, voiceId:r.voiceIdMinimax, voiceSettings:{emotion:'neutral', ...r.voiceSettings}, convSettings:r.convSettings||{}, aliases:r.aliases||[], capabilities:r.capabilities||[], imageStyle:r.imageStyle||'', heygenAvatarId:r.heygenAvatarId||'', heygenAvatarUrl:r.heygenAvatarUrl||'', avatar:null });
                      setEditLoading(false);
                    } else {
                      setEditMsg('完整資料載入失敗——請關閉視窗重開，此狀態下不能儲存（避免把欄位洗成空白）');
                    }
                  }} style={{ padding:'5px 10px', borderRadius:6, border:'1px solid var(--border)',
                    background:'transparent', color:'var(--text)', fontSize:12, cursor:'pointer' }}>
                    編輯
                  </button>
                  <button onClick={() => openBrandAssets(c.id, c.name)}
                    style={{ padding:'5px 10px', borderRadius:6, border:'1px solid var(--border)',
                      background:'transparent', color:'var(--accent-2)', fontSize:12, cursor:'pointer' }}>
                    品牌素材
                  </button>
                  {charDeleteConfirmId === c.id ? (
                    <div style={{ display:'flex', gap:4 }}>
                      <button onClick={() => deleteChar(c.id)}
                        style={{ fontSize:11, padding:'3px 9px', borderRadius:5, border:'1px solid rgba(181,101,74,0.45)',
                          background:'rgba(181,101,74,0.1)', color:'#b5654a', cursor:'pointer', fontWeight:500 }}>
                        確認刪除
                      </button>
                      <button onClick={() => setCharDeleteConfirmId(null)}
                        style={{ fontSize:11, padding:'3px 7px', borderRadius:5, border:'1px solid var(--border)',
                          background:'transparent', color:'var(--muted)', cursor:'pointer' }}>
                        取消
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setCharDeleteConfirmId(c.id)}
                      style={{ width:28, height:28, borderRadius:6, border:'1px solid var(--border)', background:'transparent',
                        color:'var(--muted)', display:'grid', placeItems:'center', cursor:'pointer' }}
                      onMouseEnter={e=>(e.currentTarget as HTMLButtonElement).style.color='#b5654a'}
                      onMouseLeave={e=>(e.currentTarget as HTMLButtonElement).style.color='var(--muted)'}>
                      <Icon name="trash" size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {list.length === 0 && <div style={{ fontSize:13, color:'var(--muted)', padding:'8px 4px' }}>還沒有角色</div>}
          </div>
        </div>

        {/* Create form */}
        <div style={{ background:'var(--panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:24, display:'flex', flexDirection:'column', gap:14 }} className="ax-enter">
          <div style={{ fontSize:15, fontWeight:600 }}>建立新角色</div>
          <Field label="角色名"><TextInput value={name} onChange={e=>setName(e.target.value)} placeholder="角色名" /></Field>
          <Field label="靈魂（用角色能理解的話寫）">
            <textarea style={{ ...inputBase, minHeight:140, resize:'vertical', fontFamily:'inherit' }}
              placeholder="用第一人稱描述角色的個性、語氣、記憶、使命…" value={soul} onChange={e=>setSoul(e.target.value)} />
          </Field>
          <Field label="別名（每行一個，選填，多人房點名用）">
            <textarea style={{ ...inputBase, minHeight:60, resize:'vertical', fontFamily:'inherit', fontSize:13 }}
              placeholder={'例：\n福哥\n王永福'} value={createAliases} onChange={e=>setCreateAliases(e.target.value)} />
          </Field>
          <Field label="角色能力（派發任務權限，選填）">
            <div style={{ display:'flex', gap:12, flexWrap:'wrap', padding:'6px 0' }}>
              {ALL_CAPABILITIES.map(cap => (
                <label key={cap.value} style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, cursor:'pointer' }}>
                  <input type="checkbox"
                    checked={createCaps.includes(cap.value)}
                    onChange={e => setCreateCaps(prev => e.target.checked ? [...prev, cap.value] : prev.filter(c => c !== cap.value))} />
                  {cap.label}
                </label>
              ))}
            </div>
          </Field>
          <Field label="MiniMax Voice ID（選填）">
            <TextInput value={voiceId} onChange={e=>setVoiceId(e.target.value)} placeholder="voice id" />
          </Field>
          {voiceId.trim() && (
            <>
              <VoicePanel vs={voiceSettings} onChange={setVoiceSettings} />
              <ConvPanel cs={convSettings} onChange={setConvSettings} />
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <div style={{ flex:1 }}><TextInput value={auditionText} onChange={e=>setAuditionText(e.target.value)} placeholder="試聽句子" /></div>
                <button style={{ padding:'10px 16px', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--text)', fontSize:14, cursor:'pointer' }}
                  disabled={testPlaying || !voiceId.trim() || !auditionText.trim()}
                  onClick={() => playVoice(voiceId, voiceSettings, auditionText, setTestPlaying)}>
                  {testPlaying ? '播放中…' : '試聽'}
                </button>
              </div>
            </>
          )}
          <div>
            <label style={{ fontSize:12, color:'var(--muted)', display:'block', marginBottom:6 }}>頭像</label>
            <input type="file" accept="image/*" onChange={onAvatar} style={{ fontSize:13 }} />
            {avatar && <img src={avatar.b64} alt="" style={{ width:70, height:70, borderRadius:10, objectFit:'cover', marginTop:10, display:'block' }} />}
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={preview} disabled={!!busy || !name || soul.length < 10}
              style={{ padding:'10px 18px', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--text)', fontSize:14, cursor:'pointer' }}>
              {busy==='preview' ? '提煉中…' : '預覽 soulCore'}
            </button>
            <GlowButton onClick={create} disabled={!!busy || !name || soul.length < 10}>
              {busy==='create' ? '建立中…' : '建立角色'}
            </GlowButton>
          </div>
          {soulCore && <pre style={{ background:'var(--panel-2)', border:'1px solid var(--border)', borderRadius:8, padding:14, fontSize:12.5, whiteSpace:'pre-wrap', maxHeight:260, overflowY:'auto', fontFamily:'monospace', lineHeight:1.6 }}>{soulCore}</pre>}
          {msg && <div style={{ fontSize:13, color: msg.startsWith('已') ? '#6f8c5f' : '#b5654a', display:'flex', alignItems:'center', gap:6 }}><Dot color={msg.startsWith('已') ? '#6f8c5f' : '#b5654a'} />{msg}</div>}
        </div>
      </div>

      {/* Brand Assets Modal */}
      {baCharId && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.55)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:100 }}
          onClick={e => { if (e.target===e.currentTarget) setBaCharId(null); }}>
          <div style={{ background:'var(--panel)', border:'1px solid var(--border-strong)', borderRadius:'var(--radius)',
            padding:28, width:'100%', maxWidth:780, display:'flex', flexDirection:'column', gap:20,
            maxHeight:'90vh', overflowY:'auto', boxShadow:'0 24px 60px -20px rgba(0,0,0,0.35)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div style={{ fontSize:16, fontWeight:600 }}>品牌素材 — {baCharName}</div>
              <button onClick={() => setBaCharId(null)}
                style={{ width:32, height:32, borderRadius:6, border:'1px solid var(--border)', background:'transparent', color:'var(--muted)', display:'grid', placeItems:'center', cursor:'pointer' }}>
                <Icon name="close" size={16} />
              </button>
            </div>
            {baMsg && <div style={{ fontSize:13, color:'#b5654a' }}>{baMsg}</div>}

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:24 }}>
              {/* Layouts */}
              <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
                <div style={{ fontSize:12, fontWeight:600, color:'var(--muted)', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:10 }}>全版 Layout</div>
                <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:16 }}>
                  {layouts.map(l => (
                    <div key={l.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderRadius:8,
                      border:'1px solid var(--border)', background:'var(--panel-2)' }}>
                      <img src={l.imageUrl} alt={l.name} style={{ width:44, height:44, objectFit:'cover', borderRadius:6, flexShrink:0, border:'1px solid var(--border)' }} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{l.name}</div>
                        {l.isDefault && (
                          <span style={{ display:'inline-block', marginTop:3, fontSize:11, color:'var(--accent)',
                            background:'color-mix(in oklab, var(--accent) 12%, transparent)',
                            padding:'1px 7px', borderRadius:4, fontWeight:500 }}>預設</span>
                        )}
                      </div>
                      <div style={{ display:'flex', gap:5, flexShrink:0, alignItems:'center' }}>
                        {!l.isDefault && (
                          <button onClick={() => setDefaultLayout(baCharId, l.id)}
                            style={{ padding:'4px 9px', borderRadius:5, border:'1px solid var(--border)',
                              background:'transparent', color:'var(--muted)', fontSize:11, cursor:'pointer', whiteSpace:'nowrap' }}>
                            設預設
                          </button>
                        )}
                        {baDeleteConfirmId === `layout:${l.id}` ? (
                          <div style={{ display:'flex', gap:4 }}>
                            <button onClick={() => { deleteLayout(baCharId, l.id); setBaDeleteConfirmId(null); }}
                              style={{ fontSize:11, padding:'4px 9px', borderRadius:5, border:'1px solid rgba(181,101,74,0.45)',
                                background:'rgba(181,101,74,0.1)', color:'#b5654a', cursor:'pointer', fontWeight:500, whiteSpace:'nowrap' }}>
                              確認刪除
                            </button>
                            <button onClick={() => setBaDeleteConfirmId(null)}
                              style={{ fontSize:11, padding:'4px 7px', borderRadius:5, border:'1px solid var(--border)',
                                background:'transparent', color:'var(--muted)', cursor:'pointer' }}>
                              取消
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => setBaDeleteConfirmId(`layout:${l.id}`)}
                            style={{ width:28, height:28, borderRadius:5, border:'1px solid var(--border)',
                              background:'transparent', color:'var(--muted)', display:'grid', placeItems:'center', cursor:'pointer' }}
                            onMouseEnter={e=>(e.currentTarget as HTMLButtonElement).style.color='#b5654a'}
                            onMouseLeave={e=>(e.currentTarget as HTMLButtonElement).style.color='var(--muted)'}>
                            <Icon name="trash" size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {layouts.length === 0 && (
                    <div style={{ fontSize:13, color:'var(--muted)', padding:'12px 0', textAlign:'center',
                      border:'1px dashed var(--border)', borderRadius:8 }}>尚無 Layout</div>
                  )}
                </div>

                {/* 新增 Layout 表單 */}
                <div style={{ borderTop:'1px solid var(--border)', paddingTop:14, display:'flex', flexDirection:'column', gap:9 }}>
                  <div style={{ fontSize:12, fontWeight:600, color:'var(--muted)' }}>新增 Layout</div>
                  <input placeholder="名稱" value={layoutForm.name} onChange={e=>setLayoutForm({...layoutForm,name:e.target.value})}
                    style={{ ...inputBase, fontSize:13 }} />
                  <input placeholder="說明（選填）" value={layoutForm.description} onChange={e=>setLayoutForm({...layoutForm,description:e.target.value})}
                    style={{ ...inputBase, fontSize:13 }} />
                  <label style={{ display:'flex', alignItems:'center', gap:7, fontSize:12.5, cursor:'pointer', color:'var(--muted)' }}>
                    <input type="checkbox" checked={layoutForm.isDefault} onChange={e=>setLayoutForm({...layoutForm,isDefault:e.target.checked})} />
                    設為預設版型
                  </label>
                  <input ref={layoutFileRef} type="file" accept="image/*" style={{ display:'none' }}
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setLayoutFile(f);
                      setLayoutPreview(URL.createObjectURL(f));
                    }} />
                  {layoutPreview ? (
                    <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
                      <img src={layoutPreview} alt="預覽" style={{ width:64, height:64, objectFit:'cover', borderRadius:7, border:'1px solid var(--border)', flexShrink:0 }} />
                      <div style={{ flex:1, display:'flex', flexDirection:'column', gap:6 }}>
                        <div style={{ fontSize:12, color:'var(--muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {layoutFile?.name}
                        </div>
                        <div style={{ display:'flex', gap:6 }}>
                          <button
                            onClick={() => baCharId && layoutFile && uploadLayout(baCharId, layoutFile)}
                            disabled={baUploading==='layout'}
                            style={{ flex:1, padding:'7px 0', borderRadius:6, border:'none',
                              background:'var(--accent)', color:'#fff', fontSize:12.5, cursor: baUploading==='layout' ? 'not-allowed' : 'pointer', fontWeight:500 }}>
                            {baUploading==='layout' ? '上傳中…' : '上傳'}
                          </button>
                          <button onClick={() => { setLayoutFile(null); setLayoutPreview(null); if (layoutFileRef.current) layoutFileRef.current.value=''; }}
                            style={{ padding:'7px 10px', borderRadius:6, border:'1px solid var(--border)',
                              background:'transparent', color:'var(--muted)', fontSize:12, cursor:'pointer' }}>
                            移除
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => layoutFileRef.current?.click()}
                      style={{ padding:'9px', borderRadius:7, border:'1px dashed var(--border)',
                        background:'transparent', color:'var(--muted)', fontSize:13, cursor:'pointer',
                        display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                      <Icon name="upload" size={14} />選擇圖片
                    </button>
                  )}
                </div>
              </div>

              {/* Products */}
              <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
                <div style={{ fontSize:12, fontWeight:600, color:'var(--muted)', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:10 }}>產品圖</div>

                {/* Grid display */}
                {products.length > 0 && (
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:16 }}>
                    {products.map(p => (
                      <div key={p.id} style={{ position:'relative', aspectRatio:'1', borderRadius:8, overflow:'hidden',
                        border:'1px solid var(--border)', background:'var(--panel-2)' }}
                        onMouseEnter={e => {
                          const btn = e.currentTarget.querySelector<HTMLElement>('.prod-del-btn');
                          if (btn) btn.style.opacity = '1';
                        }}
                        onMouseLeave={e => {
                          const btn = e.currentTarget.querySelector<HTMLElement>('.prod-del-btn');
                          if (btn) btn.style.opacity = '0';
                          setBaDeleteConfirmId(null);
                        }}>
                        <img src={p.imageUrl} alt={p.name}
                          style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} />
                        <div className="prod-del-btn" style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.45)',
                          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:6,
                          opacity:0, transition:'opacity 0.15s' }}>
                          <div style={{ fontSize:11, color:'#fff', fontWeight:500, textAlign:'center', padding:'0 6px',
                            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'100%' }}>{p.name}</div>
                          {baDeleteConfirmId === `product:${p.id}` ? (
                            <div style={{ display:'flex', gap:4 }}>
                              <button onClick={() => { deleteProduct(baCharId!, p.id); setBaDeleteConfirmId(null); }}
                                style={{ fontSize:11, padding:'3px 8px', borderRadius:4,
                                  border:'1px solid rgba(181,101,74,0.7)', background:'rgba(181,101,74,0.85)',
                                  color:'#fff', cursor:'pointer', fontWeight:500 }}>
                                刪除
                              </button>
                              <button onClick={() => setBaDeleteConfirmId(null)}
                                style={{ fontSize:11, padding:'3px 7px', borderRadius:4,
                                  border:'1px solid rgba(255,255,255,0.3)', background:'transparent',
                                  color:'#fff', cursor:'pointer' }}>
                                取消
                              </button>
                            </div>
                          ) : (
                            <button onClick={() => setBaDeleteConfirmId(`product:${p.id}`)}
                              style={{ padding:'4px 10px', borderRadius:5, border:'1px solid rgba(255,255,255,0.4)',
                                background:'transparent', color:'#fff', fontSize:11, cursor:'pointer' }}>
                              移除
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {products.length === 0 && productQueue.filter(i => i.status !== 'done').length === 0 && (
                  <div style={{ fontSize:13, color:'var(--muted)', padding:'12px 0', textAlign:'center',
                    border:'1px dashed var(--border)', borderRadius:8, marginBottom:16 }}>尚無產品圖</div>
                )}

                {/* Upload queue status */}
                {productQueue.length > 0 && (
                  <div style={{ display:'flex', flexDirection:'column', gap:4, marginBottom:12 }}>
                    {productQueue.filter(i => i.status !== 'done').map(item => (
                      <div key={item.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px',
                        borderRadius:6, border:'1px solid var(--border)', background:'var(--panel-2)', fontSize:12 }}>
                        <img src={item.previewUrl} alt={item.name}
                          style={{ width:28, height:28, objectFit:'cover', borderRadius:4, border:'1px solid var(--border)', flexShrink:0 }} />
                        <div style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--muted)' }}>
                          {item.name}
                        </div>
                        <div style={{ flexShrink:0, fontSize:11,
                          color: item.status === 'error' ? '#b5654a' : item.status === 'uploading' ? 'var(--accent)' : 'var(--muted)' }}>
                          {item.status === 'uploading' ? '上傳中…' : item.status === 'error' ? '失敗' : '佇列中'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Drop zone */}
                <div style={{ borderTop:'1px solid var(--border)', paddingTop:14 }}>
                  <div style={{ fontSize:12, fontWeight:600, color:'var(--muted)', marginBottom:9 }}>批量上傳產品圖</div>
                  <input ref={productDropRef} type="file" accept="image/*" multiple style={{ display:'none' }}
                    onChange={e => { if (e.target.files && baCharId) { addProductFiles(e.target.files, baCharId); e.target.value = ''; } }} />
                  <div
                    onClick={() => productDropRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setIsDraggingProduct(true); }}
                    onDragLeave={() => setIsDraggingProduct(false)}
                    onDrop={e => {
                      e.preventDefault();
                      setIsDraggingProduct(false);
                      if (e.dataTransfer.files && baCharId) addProductFiles(e.dataTransfer.files, baCharId);
                    }}
                    style={{ padding:'20px 12px', borderRadius:8,
                      border: `2px dashed ${isDraggingProduct ? 'var(--accent)' : 'var(--border)'}`,
                      background: isDraggingProduct ? 'color-mix(in oklab, var(--accent) 6%, transparent)' : 'transparent',
                      color: isDraggingProduct ? 'var(--accent)' : 'var(--muted)',
                      fontSize:13, cursor:'pointer', textAlign:'center',
                      display:'flex', flexDirection:'column', alignItems:'center', gap:6,
                      transition:'border-color 0.15s, background 0.15s, color 0.15s' }}>
                    <Icon name="upload" size={18} />
                    <div>拖放圖片到這裡，或點選選擇</div>
                    <div style={{ fontSize:11, opacity:0.65 }}>支援多選 · 自動以檔名命名</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editing && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.55)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:100 }}
          onClick={e => { if (e.target===e.currentTarget) setEditing(null); }}>
          <div style={{ background:'var(--panel)', border:'1px solid var(--border-strong)', borderRadius:'var(--radius)',
            padding:28, width:'100%', maxWidth:560, display:'flex', flexDirection:'column', gap:14,
            maxHeight:'90vh', overflowY:'auto', boxShadow:'0 24px 60px -20px rgba(0,0,0,0.35)' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:2 }}>
              <div style={{ fontSize:16, fontWeight:600 }}>
                編輯角色 — {editing.name}
                {editLoading && <span style={{ marginLeft:10, fontSize:12, fontWeight:400, color:'var(--muted)' }}>載入完整資料中…</span>}
              </div>
              <button onClick={() => setEditing(null)} title="關閉"
                style={{ display:'grid', placeItems:'center', width:32, height:32, borderRadius:6, flexShrink:0,
                  border:'1px solid var(--border)', background:'transparent', color:'var(--muted)', cursor:'pointer' }}>
                <Icon name="close" size={16} />
              </button>
            </div>
            <Field label="角色名"><TextInput value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})} /></Field>
            <Field label="別名（每行一個，多人房點名用）">
              <textarea style={{ ...inputBase, minHeight:80, resize:'vertical', fontFamily:'inherit', fontSize:13 }}
                placeholder={'聖嚴\n聖嚴法師\n圣严\n法師'}
                value={editing.aliases.join('\n')}
                onChange={e=>setEditing({...editing, aliases: e.target.value.split('\n')})} />
            </Field>
            <Field label="角色能力（派發任務權限）">
              <div style={{ display:'flex', gap:12, flexWrap:'wrap', padding:'6px 0' }}>
                {ALL_CAPABILITIES.map(cap => (
                  <label key={cap.value} style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, cursor:'pointer' }}>
                    <input type="checkbox"
                      checked={editing.capabilities.includes(cap.value)}
                      onChange={e => {
                        const next = e.target.checked
                          ? [...editing.capabilities, cap.value]
                          : editing.capabilities.filter(c => c !== cap.value);
                        setEditing({...editing, capabilities: next});
                      }} />
                    {cap.label}
                  </label>
                ))}
              </div>
            </Field>
            {editing.capabilities.includes('story_draft') && (
              <Field label="圖片風格（story_draft 用）">
                <TextInput value={editing.imageStyle} onChange={e=>setEditing({...editing,imageStyle:e.target.value})}
                  placeholder="例：cinematic photography, warm tones, realistic" />
              </Field>
            )}
            {editing.capabilities.includes('video_generation') && (
              <Field label="HeyGen 分身照片">
                <HeygenAvatarUpload
                  charId={editing.id}
                  currentId={editing.heygenAvatarId}
                  currentUrl={editing.heygenAvatarUrl}
                  onUploaded={(id, url) => setEditing({ ...editing, heygenAvatarId: id, heygenAvatarUrl: url })}
                />
              </Field>
            )}
            <Field label="靈魂（留空不更新）">
              <textarea style={{ ...inputBase, minHeight:110, resize:'vertical', fontFamily:'inherit' }}
                placeholder="靈魂（留空不更新）" value={editing.soul} onChange={e=>setEditing({...editing,soul:e.target.value})} />
            </Field>
            <Field label="MiniMax Voice ID">
              <TextInput value={editing.voiceId} onChange={e=>setEditing({...editing,voiceId:e.target.value})} placeholder="voice id" />
            </Field>
            {editing.voiceId.trim() && (
              <>
                <VoicePanel vs={editing.voiceSettings} onChange={vs=>setEditing({...editing,voiceSettings:vs})} />
                <ConvPanel cs={editing.convSettings} onChange={cs=>setEditing({...editing,convSettings:cs})} />
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <div style={{ flex:1 }}><TextInput value={editAuditionText} onChange={e=>setEditAuditionText(e.target.value)} placeholder="試聽句子" /></div>
                  <button style={{ padding:'10px 16px', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--text)', fontSize:14, cursor:'pointer' }}
                    disabled={editTestPlaying || !editing.voiceId.trim() || !editAuditionText.trim()}
                    onClick={()=>playVoice(editing.voiceId,editing.voiceSettings,editAuditionText,setEditTestPlaying)}>
                    {editTestPlaying ? '播放中…' : '試聽'}
                  </button>
                </div>
              </>
            )}
            <div>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                <label style={{ fontSize:12, color:'var(--muted)', fontWeight:600 }}>系統 Prompt（直接吃這個）</label>
                {editing.soul.length >= 10 && (
                  <button style={{ padding:'4px 10px', borderRadius:6, border:'1px solid var(--border)', background:'transparent', color:'var(--text)', fontSize:12, cursor:'pointer' }}
                    onClick={reEnhanceEdit} disabled={!!editBusy}>
                    {editBusy==='enhance' ? '提煉中…' : '重新提煉'}
                  </button>
                )}
              </div>
              <textarea style={{ ...inputBase, minHeight:220, fontFamily:'monospace', fontSize:13, lineHeight:1.6, resize:'vertical' }}
                placeholder="soulCore（直接改這裡，存下去馬上生效）"
                value={editing.soulCore} onChange={e=>setEditing({...editing,soulCore:e.target.value})} />
            </div>
            <div>
              <label style={{ fontSize:12, color:'var(--muted)', display:'block', marginBottom:6 }}>換頭像</label>
              <input type="file" accept="image/*" onChange={onEditAvatar} style={{ fontSize:13 }} />
              {editing.avatar && <img src={editing.avatar.b64} alt="" style={{ width:60, height:60, borderRadius:10, objectFit:'cover', marginTop:8, display:'block' }} />}
            </div>
            {editMsg && <div style={{ fontSize:13, color:'#b5654a' }}>{editMsg}</div>}
            <div style={{ display:'flex', gap:10, marginTop:4 }}>
              <GlowButton onClick={saveEdit} disabled={!!editBusy || !editing.name || editLoading}>
                {editBusy==='save' ? '儲存中…' : editLoading ? '載入中…' : '儲存'}
              </GlowButton>
              <button onClick={() => setEditing(null)}
                style={{ padding:'10px 18px', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--text)', fontSize:14, cursor:'pointer' }}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@media (max-width:760px){.ax-char-grid{grid-template-columns:1fr !important}}`}</style>
    </div>
  );
}
