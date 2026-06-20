'use client';
import { useState, ReactNode, CSSProperties } from 'react';

// ── Icons ─────────────────────────────────────────────────────────────────────
const PATHS: Record<string, ReactNode> = {
  mic: <><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></>,
  micOff: <><path d="M9 9v2a3 3 0 0 0 4.6 2.5"/><path d="M15 10V6a3 3 0 0 0-6 0"/><path d="M5 11a7 7 0 0 0 10.5 6"/><path d="M12 18v3"/><path d="M3 3l18 18"/></>,
  phone: <path d="M14.5 3.5l1.8 4.2-2.1 1.6a11 11 0 0 0 5 5l1.6-2.1 4.2 1.8"/>,
  phoneOff: <><path d="M2 8.5c6-4 12-4 18 0l-1.5 3-3.2-.6-.5-2.6a9 9 0 0 0-4.6 0l-.5 2.6-3.2.6L2 8.5z"/><path d="M2 2l20 20"/></>,
  send: <path d="M4 12l16-7-7 16-2.5-6.5L4 12z"/>,
  back: <path d="M15 5l-7 7 7 7"/>,
  doc: <><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h6"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  logout: <><path d="M9 4H5v16h4"/><path d="M15 8l4 4-4 4M19 12H9"/></>,
  users: <><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6"/><path d="M18 20a5.5 5.5 0 0 0-3-4.9"/></>,
  key: <><circle cx="8" cy="8" r="4"/><path d="M11 11l8 8M16 16l2-2M18 18l2-2"/></>,
  brain: <><path d="M12 5a3 3 0 0 0-5.5-1.7A3 3 0 0 0 4 8a3 3 0 0 0 1 5.6V16a3 3 0 0 0 5 2.2"/><path d="M12 5a3 3 0 0 1 5.5-1.7A3 3 0 0 1 20 8a3 3 0 0 1-1 5.6V16a3 3 0 0 1-5 2.2"/><path d="M12 5v14"/></>,
  mask: <><path d="M4 6c0-1 1-2 3-2 2 0 3 1 5 1s3-1 5-1c2 0 3 1 3 2 0 5-2 11-8 11S4 11 4 6z"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="9" r="1"/></>,
  chevron: <path d="M9 6l6 6-6 6"/>,
  chevronDown: <path d="M6 9l6 6 6-6"/>,
  check: <path d="M5 12l5 5L20 7"/>,
  trash: <><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></>,
  download: <><path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 20h14"/></>,
  external: <><path d="M14 5h5v5M19 5l-8 8"/><path d="M18 13v6H5V6h6"/></>,
  upload: <><path d="M12 16V5M8 9l4-4 4 4"/><path d="M5 20h14"/></>,
  search: <><circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/></>,
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></>,
  audio: <><path d="M9 18V6l11-3v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="15" r="3"/></>,
  spinner: <circle cx="12" cy="12" r="8" strokeDasharray="38" strokeDashoffset="12"/>,
  refresh: <><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.8 1 6.4 2.6L21 8"/><path d="M21 3v5h-5"/></>,
  'chevron-left': <path d="M15 6l-6 6 6 6"/>,
  'chevron-right': <path d="M9 6l6 6-6 6"/>,
  edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></>,
  close: <path d="M18 6L6 18M6 6l12 12"/>,
};

export function Icon({ name, size = 20, style }: { name: string; size?: number; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" style={{ width: size, height: size, fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, flexShrink: 0, ...style }}>
      {PATHS[name] || null}
    </svg>
  );
}

// ── Wordmark ──────────────────────────────────────────────────────────────────
export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: size * 1.25, height: size * 1.25, borderRadius: 4, background: 'var(--accent)',
        display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <div style={{ width: size * 0.4, height: size * 0.4, borderRadius: '50%', background: '#fbfaf6', opacity: 0.95 }} />
      </div>
      <span style={{ fontWeight: 600, fontSize: size, letterSpacing: '-0.01em' }}>
        ailive<span style={{ color: 'var(--accent)' }}>X</span>
      </span>
    </div>
  );
}

// ── Avatar ────────────────────────────────────────────────────────────────────
const GRADIENTS = [
  ['#c9a882','#8c6e54'], ['#8a9e80','#5a7250'], ['#9a9389','#6f685d'],
  ['#7f9068','#4a6040'], ['#9b8aa3','#6a5a72'], ['#bb9696','#8a6060'],
];
function getGrad(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

export function Avatar({ name, avatarUrl, size = 48, ring = false }:
  { name: string; avatarUrl?: string; size?: number; ring?: boolean }) {
  const r = Math.min(size * 0.22, 14);
  const grad = getGrad(name);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {ring && (
        <div style={{ position: 'absolute', inset: -3, borderRadius: r + 3,
          border: `1px solid color-mix(in oklab, ${grad[1]} 45%, transparent)` }} />
      )}
      <div style={{ width: size, height: size, borderRadius: r, overflow: 'hidden',
        background: `linear-gradient(155deg, ${grad[0]}, ${grad[1]})`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 500, color: '#fbfaf6', fontSize: size * 0.38,
        boxShadow: 'var(--shadow)', flexShrink: 0 }}>
        {avatarUrl
          ? <img src={avatarUrl} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{ lineHeight: 1 }}>{name[0] || '?'}</span>}
      </div>
    </div>
  );
}

// ── GlowButton ────────────────────────────────────────────────────────────────
type Variant = 'primary' | 'ghost' | 'soft' | 'danger';

export function GlowButton({ children, onClick, variant = 'primary', disabled, full, size = 'md', style, type }:
  { children: ReactNode; onClick?: () => void; variant?: Variant; disabled?: boolean;
    full?: boolean; size?: 'sm' | 'md' | 'lg'; style?: CSSProperties; type?: 'button' | 'submit' }) {
  const [hover, setHover] = useState(false);
  const pad = size === 'lg' ? '15px 26px' : size === 'sm' ? '8px 14px' : '12px 20px';
  const fs = size === 'lg' ? 16 : size === 'sm' ? 13 : 14.5;
  const v: Record<Variant, CSSProperties> = {
    primary: { background: hover ? 'color-mix(in oklab, var(--accent) 88%, #000)' : 'var(--accent)',
      color: '#fbfaf6', boxShadow: hover ? 'var(--shadow-hover)' : 'var(--shadow)' },
    ghost: { background: hover ? 'rgba(60,52,40,0.05)' : 'transparent', color: 'var(--text)',
      border: '1px solid var(--border-strong)' },
    soft: { background: hover ? 'rgba(60,52,40,0.08)' : 'rgba(60,52,40,0.045)', color: 'var(--text)',
      border: '1px solid var(--border)' },
    danger: { background: hover ? 'rgba(181,101,74,0.12)' : 'rgba(181,101,74,0.06)', color: '#a8553c',
      border: '1px solid rgba(181,101,74,0.3)' },
  };
  return (
    <button type={type || 'button'} onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 9,
        padding: pad, fontSize: fs, fontWeight: 500, borderRadius: 6,
        border: '1px solid transparent', width: full ? '100%' : 'auto',
        transition: 'transform .15s, box-shadow .25s, background .2s, opacity .2s, border-color .2s',
        opacity: disabled ? 0.45 : 1, pointerEvents: disabled ? 'none' : 'auto',
        transform: hover && !disabled ? 'translateY(-1px)' : 'none', whiteSpace: 'nowrap',
        ...v[variant], ...style }}>
      {children}
    </button>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────
export function Panel({ children, style, pad = 22, hover: hoverProp, onClick }:
  { children: ReactNode; style?: CSSProperties; pad?: number; hover?: boolean; onClick?: () => void }) {
  const [h, setH] = useState(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => hoverProp && setH(true)} onMouseLeave={() => hoverProp && setH(false)}
      style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: pad,
        boxShadow: h ? 'var(--shadow-hover)' : 'var(--shadow)',
        transform: h ? 'translateY(-3px)' : 'none',
        transition: 'transform .25s cubic-bezier(.2,.8,.2,1), box-shadow .25s, border-color .25s',
        borderColor: h ? 'var(--border-strong)' : 'var(--border)',
        cursor: onClick ? 'pointer' : 'default', ...style }}>
      {children}
    </div>
  );
}

// ── Tag ───────────────────────────────────────────────────────────────────────
export function Tag({ children, color = 'var(--muted)', style }:
  { children: ReactNode; color?: string; style?: CSSProperties }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 500,
      padding: '3px 9px', borderRadius: 4, lineHeight: 1.4,
      color, background: `color-mix(in oklab, ${color} 12%, transparent)`,
      border: `1px solid color-mix(in oklab, ${color} 30%, transparent)`, ...style }}>
      {children}
    </span>
  );
}

// ── Dot ───────────────────────────────────────────────────────────────────────
export function Dot({ color, pulse = false, size = 8 }: { color: string; pulse?: boolean; size?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: 99, background: color, flexShrink: 0, display: 'inline-block',
      animation: pulse ? 'ax-dot 1.4s ease-in-out infinite' : 'none' }} />
  );
}

// ── Typing indicator ──────────────────────────────────────────────────────────
export function Typing() {
  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center', padding: '4px 2px' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--muted)',
          animation: `ax-type 1.2s ease-in-out ${i * 0.16}s infinite` }} />
      ))}
    </div>
  );
}

// ── AudioAura ─────────────────────────────────────────────────────────────────
export function AudioAura({ active, color, size = 300 }: { active: boolean; color: string; size?: number }) {
  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'grid', placeItems: 'center' }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{ position: 'absolute', width: size, height: size, borderRadius: '50%',
          border: `1px solid color-mix(in oklab, ${color} 50%, transparent)`,
          animation: active ? `ax-ring 2.4s ease-out ${i * 0.8}s infinite` : 'none',
          opacity: active ? 1 : 0.15 }} />
      ))}
      <div style={{ position: 'absolute', width: size * 0.82, height: size * 0.82, borderRadius: '50%',
        background: `radial-gradient(circle, color-mix(in oklab, ${color} 28%, transparent), transparent 68%)`,
        filter: 'blur(8px)', animation: active ? 'ax-breathe 3s ease-in-out infinite' : 'none' }} />
    </div>
  );
}

// ── Equalizer ─────────────────────────────────────────────────────────────────
export function Equalizer({ active, color, bars = 5 }: { active: boolean; color: string; bars?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 22 }}>
      {Array.from({ length: bars }).map((_, i) => (
        <span key={i} style={{ width: 3, borderRadius: 2, background: color, height: active ? undefined : 4,
          animation: active ? `ax-eq 0.9s ease-in-out ${i * 0.12}s infinite` : 'none' }} />
      ))}
    </div>
  );
}

// ── Field + TextInput ─────────────────────────────────────────────────────────
export function Field({ label, hint, children }: { label?: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      {label && <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 7, color: 'var(--text)' }}>{label}</div>}
      {children}
      {hint && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>{hint}</div>}
    </label>
  );
}

export const inputStyle: CSSProperties = {
  width: '100%', padding: '11px 14px', fontSize: 14.5, color: 'var(--text)',
  background: 'var(--panel-solid)', border: '1px solid var(--border-strong)',
  borderRadius: 6, outline: 'none',
};

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [f, setF] = useState(false);
  return (
    <input {...props}
      onFocus={e => { setF(true); props.onFocus?.(e); }}
      onBlur={e => { setF(false); props.onBlur?.(e); }}
      style={{ ...inputStyle, borderColor: f ? 'var(--accent)' : 'var(--border-strong)',
        boxShadow: f ? '0 0 0 3px color-mix(in oklab, var(--accent) 14%, transparent)' : 'none',
        transition: 'border-color .2s, box-shadow .2s', ...props.style }} />
  );
}

// ── EmptyState ────────────────────────────────────────────────────────────────
export function EmptyState({ icon, title, desc, action }:
  { icon: string; title: string; desc: string; action?: ReactNode }) {
  return (
    <div className="ax-enter" style={{ display: 'grid', placeItems: 'center', textAlign: 'center', padding: '70px 20px' }}>
      <div style={{ width: 76, height: 76, borderRadius: 6, display: 'grid', placeItems: 'center', marginBottom: 20,
        background: 'rgba(60,52,40,0.04)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
        <Icon name={icon} size={34} />
      </div>
      <h3 style={{ fontSize: 19, margin: '0 0 8px', fontWeight: 600 }}>{title}</h3>
      <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0, maxWidth: 360, lineHeight: 1.7 }}>{desc}</p>
      {action && <div style={{ marginTop: 22 }}>{action}</div>}
    </div>
  );
}

// ── Ambient background ────────────────────────────────────────────────────────
export function Ambient() {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden',
      background: 'radial-gradient(120% 90% at 50% -20%, color-mix(in oklab, var(--accent) 6%, transparent), transparent 55%), linear-gradient(180deg, var(--bg), var(--bg-2))' }} />
  );
}
