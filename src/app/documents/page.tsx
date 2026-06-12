'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wordmark, Icon, Tag, Dot, Typing, EmptyState, Ambient, GlowButton } from '@/app/_components/ui';
import { LogoutButton } from '@/app/_components/LogoutButton';

interface Doc { id: string; title: string; status: string; htmlUrl: string; slidesUrl?: string; createdAt: number; }

const STATUS: Record<string, { label: string; color: string; dot: string }> = {
  pending:    { label: '排隊中',  color: 'var(--muted)',    dot: 'rgba(255,255,255,0.3)' },
  writing:    { label: '撰寫中',  color: '#c2954e',        dot: '#c2954e' },
  rendering:  { label: '排版中',  color: '#c2954e',        dot: '#c2954e' },
  done:       { label: '完成',    color: 'var(--accent-2)', dot: '#6f8c5f' },
  failed:     { label: '失敗',    color: '#b5654a',        dot: '#b5654a' },
};

function NavLink({ href, active, icon, children }: { href: string; active?: boolean; icon?: string; children: React.ReactNode }) {
  return (
    <Link href={href} style={{ display:'inline-flex', alignItems:'center', gap:6,
      background: active ? 'rgba(60,52,40,0.07)' : 'transparent',
      color: active ? 'var(--text)' : 'var(--muted)', padding:'9px 13px', borderRadius:6,
      fontSize:14, fontWeight:500, minHeight:40 }}>
      {icon && <Icon name={icon} size={16} />}{children}
    </Link>
  );
}

function DocRow({ doc, onDelete, onOpenSlides, openingSlides, onDownloadPdf, downloadingPdf }: {
  doc: Doc;
  onDelete: () => void;
  onOpenSlides: () => void;
  openingSlides: boolean;
  onDownloadPdf: () => void;
  downloadingPdf: boolean;
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
            <GlowButton variant="ghost" size="sm" onClick={onDownloadPdf} disabled={downloadingPdf}>
              <Icon name="download" size={15} />{downloadingPdf ? '生成中…' : 'PDF'}
            </GlowButton>
            <GlowButton variant="soft" size="sm" onClick={onOpenSlides} disabled={openingSlides}>
              <Icon name="external" size={15} />{openingSlides ? '建立中…' : 'Google Slides'}
            </GlowButton>
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

export default function Documents() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openingSlides, setOpeningSlides] = useState<string | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);

  async function load() {
    const r = await fetch('/api/documents').then(r => r.json()).catch(() => ({ documents: [] }));
    setDocs(r.documents || []);
    setLoaded(true);
  }

  async function deleteDoc(id: string, title: string) {
    if (!confirm(`確定刪除「${title}」？`)) return;
    await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    setDocs(prev => prev.filter(d => d.id !== id));
  }

  async function downloadPdf(id: string, title: string) {
    setDownloadingPdf(id);
    try {
      const r = await fetch(`/api/documents/${id}/pdf`);
      if (!r.ok) { alert('PDF 生成失敗，請稍後再試'); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${title}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } finally { setDownloadingPdf(null); }
  }

  async function openSlides(id: string) {
    setOpeningSlides(id);
    try {
      const r = await fetch(`/api/documents/${id}/ppt`).then(r => r.json()).catch(() => null);
      if (r?.slidesUrl) {
        window.open(r.slidesUrl, '_blank');
        setDocs(prev => prev.map(d => d.id === id ? { ...d, slidesUrl: r.slidesUrl } : d));
      } else {
        alert('Google Slides 建立失敗，請稍後再試');
      }
    } finally { setOpeningSlides(null); }
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
        {/* Nav */}
        <header style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'14px clamp(16px,4vw,26px)', borderBottom:'1px solid var(--border)',
          position:'relative', zIndex:5, background:'var(--bg)' }}>
          <Link href="/lobby"><Wordmark size={19} /></Link>
          <nav style={{ display:'flex', alignItems:'center', gap:6 }}>
            <NavLink href="/lobby">大廳</NavLink>
            <NavLink href="/documents" active icon="doc">我的文件</NavLink>
            <LogoutButton style={{ display:'inline-flex', alignItems:'center', gap:7, background:'rgba(60,52,40,0.045)',
              border:'1px solid var(--border)', borderRadius:6, padding:'8px 14px', fontSize:13,
              fontWeight:500, color:'var(--text)', cursor:'pointer' }}>
              <Icon name="logout" size={16} />登出
            </LogoutButton>
          </nav>
        </header>

        <main style={{ flex:1, overflowY:'auto', padding:'40px clamp(20px,5vw,64px) 64px' }}>
          <div style={{ maxWidth:940, margin:'0 auto' }}>
            <div style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', marginBottom:28, gap:16 }} className="ax-enter">
              <div>
                <h1 style={{ fontSize:30, margin:0, fontWeight:600, letterSpacing:'-0.02em' }}>我的文件</h1>
                <p style={{ fontSize:14.5, color:'var(--muted)', margin:'7px 0 0' }}>角色為你生成的策略書、企劃書與報告</p>
              </div>
              <div style={{ fontSize:12, color:'var(--muted)', display:'flex', alignItems:'center', gap:7 }}>
                <Dot color="var(--accent-2)" pulse size={6} />每 5 秒自動更新
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
                      onDelete={() => deleteDoc(d.id, d.title)}
                      onDownloadPdf={() => downloadPdf(d.id, d.title)}
                      downloadingPdf={downloadingPdf === d.id}
                      onOpenSlides={() => openSlides(d.id)}
                      openingSlides={openingSlides === d.id} />
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
