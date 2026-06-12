'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Avatar, Icon, Typing, Dot, Ambient } from '@/app/_components/ui';

interface Msg { role: 'user' | 'assistant'; content: string; doc?: { id: string; title: string } }
interface CharMeta { id: string; name: string; avatarUrl: string; hasVoice: boolean; }

const iconBtn: React.CSSProperties = {
  width: 38, height: 38, borderRadius: 7, border: '1px solid var(--border)',
  background: 'rgba(60,52,40,0.03)', color: 'var(--text)', display: 'grid', placeItems: 'center', flexShrink: 0,
};

export default function ChatPage() {
  const params = useParams();
  const characterId = String(params.characterId);
  const [char, setChar] = useState<CharMeta | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch(`/api/conversation/${characterId}`).then(r => r.json())
      .then(r => { if (r.character) setChar(r.character); setMsgs(r.messages || []); })
      .catch(() => {});
  }, [characterId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, sending]);

  function autosize() {
    const ta = taRef.current; if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  }

  async function send() {
    const text = input.trim(); if (!text || sending) return;
    setInput(''); setTimeout(() => { if (taRef.current) taRef.current.style.height = 'auto'; }, 0);
    setMsgs(m => [...m, { role: 'user', content: text }]);
    setSending(true);
    const r = await fetch('/api/dialogue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId, message: text }),
    }).then(r => r.json()).catch(() => null);
    setSending(false);
    if (r?.reply) {
      const newMsg: Msg = { role: 'assistant', content: r.reply };
      if (r.documents?.length) newMsg.doc = { id: r.documents[0].documentId, title: r.documents[0].title };
      setMsgs(m => [...m, newMsg]);
    } else {
      setMsgs(m => [...m, { role: 'assistant', content: '（連線出了點問題，再說一次？）' }]);
    }
  }

  return (
    <>
      <Ambient />
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>

        {/* Top bar */}
        <header style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 22px',
          borderBottom: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0 }}>
          <Link href="/lobby" style={iconBtn} title="返回大廳"><Icon name="back" size={20} /></Link>
          <Avatar name={char?.name || '…'} avatarUrl={char?.avatarUrl} size={42} ring />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{char?.name || '…'}</div>
            <div style={{ fontSize: 12, color: 'var(--accent-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Dot color="#6f8c5f" size={6} /> 線上 · 記得你
            </div>
          </div>
          {char?.hasVoice && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Link href={`/realtime/${characterId}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px', fontSize: 13.5,
                  fontWeight: 500, borderRadius: 6, border: '1px solid var(--border-strong)',
                  background: 'rgba(60,52,40,0.03)', color: 'var(--text)' }}>
                <Icon name="phone" size={16} />語音通話
              </Link>
              <Link href={`/realtime-v2/${characterId}`} title="主動插話實驗版"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 12px', fontSize: 12.5,
                  fontWeight: 500, borderRadius: 6, border: '1px dashed var(--border-strong)',
                  background: 'rgba(60,52,40,0.03)', color: 'var(--accent-2)' }}>
                <Icon name="phone" size={15} />2.0
              </Link>
              <Link href={`/realtime-v3/${characterId}`} title="主動發話 pipe-test 實驗版"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 12px', fontSize: 12.5,
                  fontWeight: 500, borderRadius: 6, border: '1px dashed var(--border-strong)',
                  background: 'rgba(60,52,40,0.03)', color: 'var(--accent-2)' }}>
                <Icon name="phone" size={15} />3.0
              </Link>
            </div>
          )}
        </header>

        {/* Messages */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '26px clamp(14px,4vw,40px)' }}>
          <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {msgs.map((m, i) => (
              <div key={i} className="ax-enter" style={{ display: 'flex', gap: 10, alignItems: 'flex-end',
                flexDirection: m.role === 'user' ? 'row-reverse' : 'row' }}>
                {m.role === 'assistant' && char && <Avatar name={char.name} avatarUrl={char.avatarUrl} size={30} />}
                <div style={{ display: 'flex', flexDirection: 'column',
                  alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 8, maxWidth: '82%' }}>
                  <div style={{
                    padding: '11px 15px', borderRadius: 8, fontSize: 15, lineHeight: 1.65,
                    maxWidth: 'min(78%, 560px)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    background: m.role === 'user' ? 'var(--accent)' : 'var(--panel)',
                    color: m.role === 'user' ? '#fff' : 'var(--text)',
                    border: m.role === 'user' ? 'none' : '1px solid var(--border)',
                    borderBottomRightRadius: m.role === 'user' ? 5 : 8,
                    borderBottomLeftRadius: m.role === 'user' ? 8 : 5,
                  }}>
                    {m.content}
                  </div>
                  {m.doc && (
                    <Link href="/documents" style={{ display: 'flex', alignItems: 'center', gap: 13,
                      padding: '12px 15px', borderRadius: 8, background: 'rgba(60,52,40,0.04)',
                      border: '1px solid var(--border-strong)', maxWidth: 360 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 6, flexShrink: 0, display: 'grid', placeItems: 'center',
                        background: 'color-mix(in oklab, var(--accent) 18%, transparent)', color: 'var(--accent)' }}>
                        <Icon name="doc" size={20} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 3 }}>文件已建立</div>
                        <div style={{ fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.doc.title}</div>
                      </div>
                      <Icon name="chevron" size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    </Link>
                  )}
                </div>
              </div>
            ))}
            {sending && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                {char && <Avatar name={char.name} avatarUrl={char.avatarUrl} size={30} />}
                <div style={{ padding: '11px 15px', borderRadius: 8, background: 'var(--panel)', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 2 }}>{char?.name} 思考中</div>
                  <Typing />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Input */}
        <div style={{ padding: '12px clamp(14px,4vw,40px) 18px', borderTop: '1px solid var(--border)',
          background: 'var(--bg)', flexShrink: 0 }}>
          <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', alignItems: 'flex-end', gap: 10,
            background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border-strong)', borderRadius: 8,
            padding: '8px 8px 8px 16px' }}>
            <textarea ref={taRef} value={input} rows={1}
              onChange={e => { setInput(e.target.value); autosize(); }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={`傳訊息給 ${char?.name || '…'}…`}
              style={{ flex: 1, resize: 'none', background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--text)', fontSize: 15, lineHeight: 1.5, padding: '8px 0',
                maxHeight: 140, fontFamily: 'inherit' }} />
            <button onClick={send} disabled={!input.trim() || sending}
              style={{ width: 40, height: 40, borderRadius: 8, border: 'none', flexShrink: 0,
                background: input.trim() && !sending ? 'var(--accent)' : 'rgba(60,52,40,0.06)',
                color: '#fff', display: 'grid', placeItems: 'center',
                opacity: input.trim() && !sending ? 1 : 0.5,
                cursor: input.trim() && !sending ? 'pointer' : 'default', transition: 'all .2s' }}>
              <Icon name="send" size={18} />
            </button>
          </div>
          <div style={{ maxWidth: 760, margin: '6px auto 0', fontSize: 11.5, color: 'var(--muted)', textAlign: 'center' }}>
            Enter 送出 · Shift + Enter 換行
          </div>
        </div>
      </div>
    </>
  );
}
