'use client';

/**
 * 文字過濾器標記（編輯模式）— 出口是人的文字（故事劇情、圖卡文字、腳本草稿）用這個：
 * 掃描踩雷片語（AI 味／農場詞）標記給編輯看，改不改由編輯決定（一鍵改寫是選項不是強制）。
 * 出口是機器的文字（文件生成、podcast）走後端自動改寫，不經過這裡。
 */
import { useEffect, useRef, useState } from 'react';

interface Hit {
  patternId: string;
  matched: string;
  index: number;
  note: string;
  category: 'ai-flavor' | 'clickbait' | 'style-guide';
}

const CATEGORY_LABEL: Record<Hit['category'], string> = {
  'ai-flavor': 'AI 味',
  'clickbait': '農場詞',
  'style-guide': '風格',
};

export function TextFilterBadge({ text, characterId, onRewritten }: {
  text: string;
  characterId?: string;
  onRewritten: (newText: string) => void;
}) {
  const [hits, setHits] = useState<Hit[]>([]);
  const [rewriting, setRewriting] = useState(false);
  const [error, setError] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!text.trim()) { setHits([]); return; }
    debounceRef.current = setTimeout(async () => {
      const r = await fetch('/api/text-filter/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }).then(r => r.json()).catch(() => null);
      if (r?.hits) setHits(r.hits);
    }, 800);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [text]);

  async function rewrite() {
    if (rewriting) return;
    setRewriting(true); setError('');
    const r = await fetch('/api/text-filter/rewrite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, characterId }),
    }).then(r => r.json()).catch(() => null);
    setRewriting(false);
    if (r?.text) onRewritten(r.text);
    else setError(r?.error ?? '改寫失敗，請重試');
  }

  if (hits.length === 0) return null;

  const unique = [...new Map(hits.map(h => [h.matched, h])).values()];

  return (
    <div style={{ marginTop: 8, padding: '9px 12px', borderRadius: 8,
      border: '1px solid rgba(194,149,78,0.3)', background: 'rgba(194,149,78,0.06)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: '#c2954e' }}>
            {hits.length} 處建議修改
          </span>
          {unique.slice(0, 6).map((h, i) => (
            <span key={i} title={h.note}
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, background: 'var(--panel)',
                border: '1px solid var(--border)', color: 'var(--muted)' }}>
              {CATEGORY_LABEL[h.category]}·{h.matched.length > 12 ? h.matched.slice(0, 12) + '…' : h.matched}
            </span>
          ))}
          {unique.length > 6 && <span style={{ fontSize: 11, color: 'var(--muted)' }}>+{unique.length - 6}</span>}
        </div>
        <button onClick={rewrite} disabled={rewriting}
          style={{ fontSize: 11.5, fontWeight: 500, padding: '4px 12px', borderRadius: 6, flexShrink: 0,
            border: '1px solid rgba(194,149,78,0.35)', background: 'rgba(194,149,78,0.1)', color: '#c2954e',
            cursor: rewriting ? 'not-allowed' : 'pointer', opacity: rewriting ? 0.5 : 1 }}>
          {rewriting ? '改寫中…' : '改寫踩雷句'}
        </button>
      </div>
      {error && <p style={{ fontSize: 11.5, color: '#b5654a', margin: '6px 0 0' }}>{error}</p>}
    </div>
  );
}
