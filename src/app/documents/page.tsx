'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon, Tag, Dot, Typing, EmptyState, Ambient, GlowButton } from '@/app/_components/ui';
import { FrontNav } from '@/app/_components/FrontNav';

interface Doc { id: string; title: string; status: string; htmlUrl: string; createdAt: number; }

const STATUS: Record<string, { label: string; color: string; dot: string }> = {
  pending:    { label: '排隊中',  color: 'var(--muted)',    dot: 'rgba(255,255,255,0.3)' },
  writing:    { label: '撰寫中',  color: '#c2954e',        dot: '#c2954e' },
  rendering:  { label: '排版中',  color: '#c2954e',        dot: '#c2954e' },
  done:       { label: '完成',    color: 'var(--accent-2)', dot: '#6f8c5f' },
  failed:     { label: '失敗',    color: '#b5654a',        dot: '#b5654a' },
};

function DocRow({ doc, onDelete }: {
  doc: Doc;
  onDelete: () => void;
}) {
  const st = STATUS[doc.status] || STATUS.pending;
  const inProgress = doc.status === 'writing' || doc.status === 'rendering' || doc.status === 'pending';
  const [h, setH] = useState(false);

  return (
    <div className="ax-enter" onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ display:'flex', alignItems:'center', gap:16, flexWrap:'wrap', rowGap:12,
        padding:'16px 20px', borderRadius:8, background:'var(--panel)',
        border:'1px solid', borderColor: h ? 'var(--border-strong)' : 'var(--border)',
        transition:'border-color .2s' }}>
      {/* icon */}
      <div style={{ width:42, height:42, borderRadius:7, flexShrink:0, display:'grid', placeItems:'center',
        background:'color-mix(in oklab, var(--accent) 14%, transparent)', color:'var(--accent)',
        border:'1px solid color-mix(in oklab, var(--accent) 24%, transparent)' }}>
        <Icon name="doc" size={20} />
      </div>
      {/* title + date */}
      <div style={{ flex:'1 1 200px', minWidth:0 }}>
        <div style={{ fontSize:15.5, fontWeight:600, marginBottom:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{doc.title}</div>
        <div style={{ fontSize:12.5, color:'var(--muted)' }}>
          {doc.createdAt ? new Date(doc.createdAt).toLocaleDateString('zh-TW', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'}
        </div>
      </div>
      {/* status */}
      <div className="doc-row-status">
        {inProgress && <Typing />}
        <Tag color={st.color}><Dot color={st.dot} pulse={inProgress} size={6} />{st.label}</Tag>
      </div>
      {/* actions */}
      <div className="doc-row-actions">
        {doc.status === 'done' ? (
          <>
            {doc.htmlUrl && (
              <GlowButton variant="ghost" size="sm" onClick={() => window.open(doc.htmlUrl, '_blank')}>
                <Icon name="external" size={15} />查看
              </GlowButton>
            )}
          </>
        ) : doc.status === 'failed' ? (
          <span style={{ fontSize:12.5, color:'#b5654a' }}>生成失敗</span>
        ) : (
          <span style={{ fontSize:12.5, color:'var(--muted)' }}>處理中…</span>
        )}
        <button onClick={onDelete} style={{ width:34, height:34, borderRadius:6, border:'1px solid var(--border)',
          background:'transparent', color:'var(--muted)', display:'grid', placeItems:'center', cursor:'pointer',
          transition:'color .2s, border-color .2s' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color='#b5654a'; (e.currentTarget as HTMLButtonElement).style.borderColor='#b5654a44'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color='var(--muted)'; (e.currentTarget as HTMLButtonElement).style.borderColor='var(--border)'; }}>
          <Icon name="trash" size={15} />
        </button>
      </div>
    </div>
  );
}

interface DocsQuota { docsLimit: number | null; docsUsed: number; docsRemaining: number | null; }

export default function Documents() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [quota, setQuota] = useState<DocsQuota | null>(null);

  async function load() {
    const r = await fetch('/api/documents').then(r => r.json()).catch(() => ({ documents: [] }));
    setDocs(r.documents || []);
    setLoaded(true);
  }

  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(r => { if (r?.quota) setQuota(r.quota); }).catch(() => {});
  }, []);

  async function deleteDoc(id: string, title: string) {
    if (!confirm(`確定刪除「${title}」？`)) return;
    const r = await fetch(`/api/documents/${id}`, { method: 'DELETE' }).catch(() => null);
    if (r?.ok) setDocs(prev => prev.filter(d => d.id !== id));
    else alert('刪除失敗，請重試。');
  }


  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <Ambient />
      <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', position:'relative', zIndex:1 }}>
        <FrontNav active="documents" />

        <main style={{ flex:1, overflowY:'auto', padding:'40px clamp(20px,5vw,64px) 64px' }}>
          <div style={{ maxWidth:940, margin:'0 auto' }}>
            <div style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', marginBottom:28, gap:16 }} className="ax-enter">
              <div>
                <h1 style={{ fontSize:30, margin:0, fontWeight:600, letterSpacing:'-0.02em' }}>我的文件</h1>
                <p style={{ fontSize:14.5, color:'var(--muted)', margin:'7px 0 0' }}>角色為你生成的策略書、企劃書與報告</p>
              </div>
              <div style={{ fontSize:12, color:'var(--muted)', display:'flex', alignItems:'center', gap:14 }}>
                {quota && quota.docsLimit !== null && (
                  <span style={{ fontFamily:'monospace' }}>
                    文件額度 {quota.docsUsed} / {quota.docsLimit}
                  </span>
                )}
                <span style={{ display:'flex', alignItems:'center', gap:7 }}>
                  <Dot color="var(--accent-2)" pulse size={6} />每 5 秒自動更新
                </span>
              </div>
            </div>

            {!loaded ? null : docs.length === 0 ? (
              <EmptyState icon="doc" title="還沒有文件"
                desc="在對話中告訴角色幫你寫一份策略書或企劃書，完成後會出現在這裡。" />
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:11 }}>
                {docs.map((d, i) => (
                  <div key={d.id} style={{ animationDelay:`${i*0.04}s` }}>
                    <DocRow doc={d}
                      onDelete={() => deleteDoc(d.id, d.title)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );
}
