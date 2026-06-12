'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  Room, RoomEvent, RemoteParticipant, RemoteTrack, RemoteTrackPublication,
  Track, ConnectionState, ConnectionQuality,
} from 'livekit-client';

type CallState = 'idle' | 'connecting' | 'connected' | 'waiting-agent' | 'in-call' | 'finalizing' | 'disconnected' | 'error';

interface Caption { who: 'user' | 'agent'; text: string; ts: number; }
interface Health {
  token: 'unknown' | 'ok' | 'fail';
  mic: 'unknown' | 'ok' | 'fail';
  micLevel: number;
  micDevice: string;
  room: 'unknown' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  agent: 'unknown' | 'present' | 'absent';
  audio: 'unknown' | 'subscribed' | 'absent';
  netQuality: 'unknown' | 'excellent' | 'good' | 'poor' | 'lost';
}
interface DiagLog { ts: number; level: 'info' | 'warn' | 'error'; msg: string; }

const INITIAL_HEALTH: Health = {
  token: 'unknown', mic: 'unknown', micLevel: 0, micDevice: '',
  room: 'unknown', agent: 'unknown', audio: 'unknown', netQuality: 'unknown',
};

// ── Perlin Noise ──
function buildNoise() {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (t: number, a: number, b: number) => a + t * (b - a);
  const grad = (hash: number, x: number, y: number, z: number) => {
    const h = hash & 15, u = h < 8 ? x : y, v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  };
  return (x: number, y: number, z: number) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = perm[X]+Y, AA = perm[A]+Z, AB = perm[A+1]+Z, B = perm[X+1]+Y, BA = perm[B]+Z, BB = perm[B+1]+Z;
    return lerp(w, lerp(v, lerp(u, grad(perm[AA],x,y,z), grad(perm[BA],x-1,y,z)), lerp(u, grad(perm[AB],x,y-1,z), grad(perm[BB],x-1,y-1,z))),
      lerp(v, lerp(u, grad(perm[AA+1],x,y,z-1), grad(perm[BA+1],x-1,y,z-1)), lerp(u, grad(perm[AB+1],x,y-1,z-1), grad(perm[BB+1],x-1,y-1,z-1))));
  };
}

type FlowParams = { noiseScale:number; speed:number; attraction:number; vortex:number; lineWidth:number; noiseZStep:number; colorAlpha:number; hueBase:number; };

const SPEAKING_PARAMS: FlowParams = {
  noiseScale: 0.007, speed: 1.35, attraction: -2.05,
  vortex: 0.0, lineWidth: 2.75, noiseZStep: 0.004, colorAlpha: 0.07, hueBase: 190,
};

const FLOW: Record<string, FlowParams> = {
  idle:       { noiseScale:0.002,  speed:0.8,  attraction:0,    vortex:0.1, lineWidth:0.4, noiseZStep:0.002, colorAlpha:0.08, hueBase:190 },
  processing: { noiseScale:0.05,   speed:0.3,  attraction:3.5,  vortex:0.3, lineWidth:1.0, noiseZStep:0.12,  colorAlpha:0.22, hueBase:280 },
  speaking:   SPEAKING_PARAMS,
};

function CircleControl({ icon, label, onClick, active, danger, hangup, big, primary, disabled }:
  { icon: string; label: string; onClick?: () => void; active?: boolean; danger?: boolean;
    hangup?: boolean; big?: boolean; primary?: boolean; disabled?: boolean }) {
  const [h, setH] = useState(false);
  const sz = big ? 68 : 56;
  const bg = hangup ? 'linear-gradient(135deg,#b5654a,#9a4f38)'
    : danger ? 'rgba(181,101,74,0.18)'
    : primary ? 'var(--accent)'
    : active ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)';
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:9 }}>
      <button onClick={onClick} disabled={disabled}
        onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
        style={{ width:sz, height:sz, borderRadius:'50%',
          border: hangup ? 'none' : '1px solid rgba(255,255,255,0.2)',
          background: bg, color: hangup||primary ? '#fff' : danger ? '#b5654a' : 'rgba(255,255,255,0.8)',
          display:'grid', placeItems:'center', transition:'transform .2s, background .2s',
          transform: h && !disabled ? 'translateY(-2px) scale(1.04)' : 'none',
          boxShadow: hangup ? '0 12px 30px -10px rgba(154,79,56,0.7)' : 'none',
          opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' }}>
        {icon === 'mic' && <svg viewBox="0 0 24 24" style={{width:22,height:22,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'}}><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>}
        {icon === 'mic-off' && <svg viewBox="0 0 24 24" style={{width:22,height:22,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'}}><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/><path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>}
        {icon === 'phone' && <svg viewBox="0 0 24 24" style={{width:22,height:22,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'}}><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 10.8a19.79 19.79 0 01-3.07-8.7A2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.91 7.91a16 16 0 006.09 6.09l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>}
        {icon === 'phone-off' && <svg viewBox="0 0 24 24" style={{width:22,height:22,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'}}><path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07"/><path d="M13.32 10.68A16 16 0 009.71 8.1L8.44 9.37a2 2 0 01-2.11.45 12.05 12.05 0 01-2.81-.7A2 2 0 012 7.14V4.12A2 2 0 014.18 2.1a19.94 19.94 0 018.7 3.07"/><line x1="23" y1="1" x2="1" y2="23"/></svg>}
        {icon === 'search' && <svg viewBox="0 0 24 24" style={{width:20,height:20,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'}}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>}
      </button>
      <span style={{ fontSize:12, color:'rgba(255,255,255,0.5)' }}>{label}</span>
    </div>
  );
}

export default function RealtimeCallPage() {
  const params = useParams<{ characterId: string }>();
  const characterId = params.characterId;

  const [state, setState] = useState<CallState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [characterImage, setCharacterImage] = useState('');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [health, setHealth] = useState<Health>(INITIAL_HEALTH);
  const [diagLogs, setDiagLogs] = useState<DiagLog[]>([]);
  const [micMuted, setMicMuted] = useState(false);
  const [agentPhase, setAgentPhase] = useState<'idle'|'thinking'|'speaking'>('idle');

  const identityRef = useRef('');
  const roomRef = useRef<Room | null>(null);
  const finalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const callStartRef = useRef<number>(0);
  const voiceEndFiredRef = useRef(false);
  const micAnalyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode; raf: number } | null>(null);
  const agentAnalyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode } | null>(null);
  const micLevelRef = useRef(0);
  const agentLevelRef = useRef(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flowRef = useRef<FlowParams>({ ...FLOW.idle });
  const targetFlowRef = useRef<FlowParams>({ ...FLOW.idle });
  const rafRef = useRef<number>(0);

  // ── Canvas 粒子 ──
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const perlin = buildNoise();
    type Pt = { x:number; y:number; prevX:number; prevY:number; velX:number; velY:number; maxSpeed:number; };
    let width = 0, height = 0, particles: Pt[] = [], zOff = 0;
    const mkPt = (): Pt => ({ x: Math.random()*width, y: Math.random()*height, prevX:0, prevY:0, velX:0, velY:0, maxSpeed: 1+Math.random()*2 });
    const resize = () => {
      width = canvas.width = window.innerWidth; height = canvas.height = window.innerHeight;
      particles = Array.from({length:4000}, mkPt);
      particles.forEach(p => { p.prevX=p.x; p.prevY=p.y; });
      ctx.fillStyle='#000'; ctx.fillRect(0,0,width,height);
    };
    const animate = () => {
      const level = Math.max(micLevelRef.current, agentLevelRef.current);
      const boosted = Math.pow(Math.min(level * 6, 1), 0.55);
      const base = targetFlowRef.current;
      const tgt: FlowParams = { ...base };
      tgt.speed   = Math.min(base.speed + boosted * 6.7 * 0.4, 6);
      tgt.vortex  = Math.min(base.vortex + boosted * 6.7 * 0.25, 5);
      tgt.attraction = base.attraction + boosted * 6.7;
      const lerpF = boosted > 0.05 ? 0.18 : 0.04;
      const cur = flowRef.current;
      (Object.keys(tgt) as (keyof FlowParams)[]).forEach(k => { cur[k] += (tgt[k] - cur[k]) * lerpF; });
      const p = flowRef.current;
      const isThinking = targetFlowRef.current.hueBase === 280;
      ctx.fillStyle = `rgba(0,0,0,${isThinking ? 0.25 : 0.07})`; ctx.fillRect(0,0,width,height);
      zOff += p.noiseZStep;
      particles.forEach(pt => {
        let angle = perlin(pt.x*p.noiseScale, pt.y*p.noiseScale, zOff) * Math.PI * 4;
        if (isThinking) angle += (Math.random()-0.5)*1.5;
        let accX = Math.cos(angle)*0.4, accY = Math.sin(angle)*0.4;
        const dx = width/2-pt.x, dy = height/2-pt.y, dist = Math.sqrt(dx*dx+dy*dy)||1;
        if (p.attraction !== 0) { accX += (dx/dist)*p.attraction; accY += (dy/dist)*p.attraction; }
        if (p.vortex !== 0) { accX += (-dy/dist)*p.vortex; accY += (dx/dist)*p.vortex; }
        pt.velX += accX; pt.velY += accY;
        let maxSpd = pt.maxSpeed*p.speed;
        if (isThinking) maxSpd *= (0.8+Math.random()*0.4);
        const spd = Math.sqrt(pt.velX**2+pt.velY**2);
        if (spd > maxSpd) { pt.velX=(pt.velX/spd)*maxSpd; pt.velY=(pt.velY/spd)*maxSpd; }
        pt.prevX=pt.x; pt.prevY=pt.y; pt.x+=pt.velX; pt.y+=pt.velY;
        const isActive = p.attraction > 0.5 || p.speed > 1.2;
        if (pt.x<-100||pt.x>width+100||pt.y<-100||pt.y>height+100) {
          if (isActive) { pt.x=width/2+(Math.random()-0.5)*50; pt.y=height/2+(Math.random()-0.5)*50; }
          else { pt.x=Math.random()*width; pt.y=Math.random()*height; }
          pt.prevX=pt.x; pt.prevY=pt.y; pt.velX=0; pt.velY=0;
        }
        ctx.beginPath(); ctx.moveTo(pt.prevX,pt.prevY); ctx.lineTo(pt.x,pt.y);
        const hue = (p.hueBase + Math.sqrt(pt.velX**2+pt.velY**2)*15) % 360;
        ctx.strokeStyle=`hsla(${hue},80%,65%,${p.colorAlpha})`;
        ctx.lineWidth=p.lineWidth; ctx.stroke();
      });
      rafRef.current = requestAnimationFrame(animate);
    };
    resize(); animate();
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); cancelAnimationFrame(rafRef.current); };
  }, []);

  const setFlowForState = useCallback((s: CallState) => {
    if (s === 'idle' || s === 'disconnected' || s === 'error') {
      targetFlowRef.current = { ...FLOW.idle };
    } else if (s === 'connecting' || s === 'waiting-agent' || s === 'finalizing') {
      targetFlowRef.current = { ...FLOW.processing };
    } else {
      targetFlowRef.current = { ...FLOW.speaking };
    }
  }, []);

  useEffect(() => {
    if (state !== 'in-call' && state !== 'waiting-agent') return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - callStartRef.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [state]);

  const log = (level: DiagLog['level'], msg: string) =>
    setDiagLogs(prev => [...prev.slice(-49), { ts: Date.now(), level, msg }]);

  const startMicMonitor = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const deviceLabel = stream.getAudioTracks()[0]?.label || 'unknown';
      setHealth(h => ({ ...h, mic: 'ok', micDevice: deviceLabel }));
      log('info', `mic: ${deviceLabel}`);
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i]-128)/128; sum += v*v; }
        micLevelRef.current = Math.sqrt(sum/buf.length);
        setHealth(h => ({ ...h, micLevel: micLevelRef.current }));
        const raf = requestAnimationFrame(tick);
        if (micAnalyserRef.current) micAnalyserRef.current.raf = raf;
      };
      tick();
      micAnalyserRef.current = { ctx, analyser, raf: 0 };
      return stream;
    } catch (e) {
      setHealth(h => ({ ...h, mic: 'fail' }));
      log('error', `mic fail: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  };

  const stopMicMonitor = () => {
    if (micAnalyserRef.current) {
      cancelAnimationFrame(micAnalyserRef.current.raf);
      micAnalyserRef.current.ctx.close();
      micAnalyserRef.current = null;
    }
    micLevelRef.current = 0;
  };

  const handleConnect = async () => {
    setState('connecting'); setFlowForState('connecting');
    setErrorMsg(''); setHealth(INITIAL_HEALTH); setDiagLogs([]);
    log('info', `connect: ${characterId}`);
    try {
      await startMicMonitor();

      const tokenRes = await fetch('/api/livekit/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId, v4: true }),
      });
      if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({}));
        setHealth(h => ({ ...h, token: 'fail' }));
        throw new Error(err.error || `token ${tokenRes.status}`);
      }
      const { token, url, roomName, identity, characterName: cName, avatarUrl } = await tokenRes.json();
      identityRef.current = identity;
      setHealth(h => ({ ...h, token: 'ok' }));
      if (cName) setCharacterName(cName);
      if (avatarUrl) setCharacterImage(avatarUrl);
      log('info', `token OK, room=${roomName}`);

      const room = new Room({ adaptiveStream: true, dynacast: true });
      room
        .on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
          log('info', `room: ${s}`);
          setHealth(h => ({
            ...h,
            room: s === ConnectionState.Connected ? 'connected'
              : s === ConnectionState.Connecting ? 'connecting'
              : s === ConnectionState.Reconnecting ? 'reconnecting' : 'disconnected',
          }));
          if (s === ConnectionState.Disconnected) { setState('disconnected'); setFlowForState('disconnected'); }
        })
        .on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p) => {
          if (p?.isLocal) {
            const map: Record<string, Health['netQuality']> = { excellent:'excellent', good:'good', poor:'poor', lost:'lost', unknown:'unknown' };
            setHealth(h => ({ ...h, netQuality: map[q] || 'unknown' }));
          }
        })
        .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
          log('info', `agent joined: ${p.identity}`);
          setHealth(h => ({ ...h, agent: 'present' }));
          setState('in-call'); setFlowForState('in-call');
        })
        .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
          log('warn', `agent left: ${p.identity}`);
          setHealth(h => ({ ...h, agent: 'absent' }));
        })
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
          log('info', `track: ${track.kind} sid=${track.sid} from=${p.identity}`);
          if (track.kind === Track.Kind.Audio) {
            if (audioElRef.current) {
              // Let LiveKit manage audio routing via its internal AudioContext.
              // Do NOT create a second AudioContext here — it causes double audio.
              track.attach(audioElRef.current);
              log('info', `audio attached, muted=${audioElRef.current.muted} vol=${audioElRef.current.volume}`);
            }
            setHealth(h => ({ ...h, audio: 'subscribed' }));
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Audio) setHealth(h => ({ ...h, audio: 'absent' }));
        })
        .on(RoomEvent.DataReceived, (payload: Uint8Array) => {
          try {
            const msg = JSON.parse(new TextDecoder().decode(payload));
            if (msg.type === 'caption' && msg.text) setCaptions(prev => [...prev, { who: msg.who || 'agent', text: msg.text, ts: Date.now() }]);
            else if (msg.type === 'character' && msg.name) setCharacterName(msg.name);
            else if (msg.type === 'agent_phase' && msg.phase) setAgentPhase(msg.phase);
          } catch { /* ignore */ }
        });

      await room.connect(url, token);
      log('info', 'connected');
      await room.localParticipant.setMicrophoneEnabled(true);
      log('info', 'mic published');

      if (room.remoteParticipants.size > 0) {
        setHealth(h => ({ ...h, agent: 'present' }));
        setState('in-call'); setFlowForState('in-call');
      }
      roomRef.current = room;
      callStartRef.current = Date.now();
      setState(s => { const ns = s === 'in-call' ? 'in-call' : 'waiting-agent'; setFlowForState(ns); return ns; });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg); setState('error'); setFlowForState('error'); log('error', msg);
    }
  };

  const fireVoiceEnd = useCallback(() => {
    if (voiceEndFiredRef.current) return;
    voiceEndFiredRef.current = true;
    const identity = identityRef.current;
    navigator.sendBeacon('/api/voice-end', new Blob(
      [JSON.stringify({ characterId, conversationId: `ailivex-voice-${characterId}-${identity}` })],
      { type: 'application/json' }
    ));
  }, [characterId]);

  const reallyDisconnect = useCallback(async () => {
    if (finalizeTimerRef.current) { clearTimeout(finalizeTimerRef.current); finalizeTimerRef.current = null; }
    fireVoiceEnd();
    if (roomRef.current) { await roomRef.current.disconnect(); roomRef.current = null; }
    stopMicMonitor();
    setState('disconnected'); setFlowForState('disconnected'); setElapsed(0); setMicMuted(false);
  }, [fireVoiceEnd, setFlowForState]);

  const handleDisconnect = useCallback(async () => {
    const room = roomRef.current;
    // 「整理中」只是短轉場給收尾感；真正的記憶收尾由 server 端 shutdown callback 保證（90s 寬限），前端不需等。
    if (room && room.state === ConnectionState.Connected) {
      setState('finalizing'); setFlowForState('finalizing');
      try { await room.localParticipant.setMicrophoneEnabled(false); } catch { /* ignore */ }
      setMicMuted(true);
      if (finalizeTimerRef.current) clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = setTimeout(() => { void reallyDisconnect(); }, 1800);
    } else {
      void reallyDisconnect();
    }
  }, [reallyDisconnect, setFlowForState]);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current; if (!room) return;
    const next = !micMuted;
    await room.localParticipant.setMicrophoneEnabled(!next);
    setMicMuted(next);
  }, [micMuted]);

  // unmount cleanup
  useEffect(() => () => {
    if (finalizeTimerRef.current) clearTimeout(finalizeTimerRef.current);
    fireVoiceEnd();
    if (roomRef.current) void roomRef.current.disconnect();
    stopMicMonitor();
  }, [fireVoiceEnd]);

  // 頁面載入時預取角色名 + 頭像（ailive 同款：進頁面就有圖，不等接通）
  useEffect(() => {
    fetch(`/api/characters/${characterId}`)
      .then(r => r.json())
      .then(d => {
        if (d.name) setCharacterName(d.name);
        if (d.avatarUrl) setCharacterImage(d.avatarUrl);
      })
      .catch(() => {});
  }, [characterId]);

  const hasCharImage = !!characterImage;
  const bgSrc = characterImage || '';
  const canConnect = state === 'idle' || state === 'disconnected' || state === 'error';
  const canDisconnect = state === 'connected' || state === 'waiting-agent' || state === 'in-call';
  const inCall = state === 'in-call' || state === 'waiting-agent';
  const min = Math.floor(elapsed / 60), sec = elapsed % 60;

  const stateLabel: Record<CallState, string> = {
    idle: '( 通話 )', connecting: '( 連線中 )', connected: '( 進房 )',
    'waiting-agent': '( 等待中 )', 'in-call': '( 通話中 )', finalizing: '( 整理記憶中… )',
    disconnected: '( 已掛斷 )', error: '( 錯誤 )',
  };

  const speaking = agentPhase === 'speaking';
  const [logOpen, setLogOpen] = useState(false);

  const HEALTH_ITEMS = [
    { key:'token', label:'Token',  ok: health.token==='ok',        fail: health.token==='fail' },
    { key:'mic',   label:'麥克風', ok: health.mic==='ok',           fail: health.mic==='fail' },
    { key:'room',  label:'房間',   ok: health.room==='connected',   fail: health.room==='disconnected' },
    { key:'agent', label:'Agent',  ok: health.agent==='present',    fail: health.agent==='absent' },
    { key:'audio', label:'音訊',   ok: health.audio==='subscribed', fail: health.audio==='absent' },
    { key:'net',   label:'網路',
      ok: health.netQuality==='excellent'||health.netQuality==='good',
      fail: health.netQuality==='lost' },
  ];

  return (
    <div style={{ position:'fixed', inset:0, overflow:'hidden', background:'#111' }}>
      {/* 底色 — 單色深底 */}
      <div style={{ position:'absolute', inset:0, background:'#0e0d0c' }} />
      {/* 全屏氛圍漸層 */}
      <div style={{ position:'absolute', inset:0,
        background: speaking
          ? 'radial-gradient(60% 50% at 50% 35%, rgba(160,110,84,0.25), transparent 65%), radial-gradient(50% 40% at 50% 100%, rgba(127,138,114,0.2), transparent 60%)'
          : 'radial-gradient(60% 50% at 50% 35%, rgba(160,110,84,0.12), transparent 65%)',
        transition:'opacity 1s' }} />
      {/* 粒子 canvas */}
      <canvas ref={canvasRef} style={{ position:'absolute', inset:0, display:'block', filter:'contrast(1.1) brightness(1.2)', mixBlendMode:'screen', opacity:0.6 }} />

      {/* Top bar */}
      <header style={{ position:'relative', zIndex:3, display:'flex', alignItems:'center', justifyContent:'space-between', padding:'16px 22px' }}>
        <Link href={`/chat/${characterId}`} style={{ width:38, height:38, borderRadius:7,
          border:'1px solid rgba(255,255,255,0.15)', background:'rgba(255,255,255,0.06)',
          color:'rgba(255,255,255,0.8)', display:'grid', placeItems:'center', flexShrink:0 }}>
          <svg viewBox="0 0 24 24" style={{width:20,height:20,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'}}>
            <path d="M15 5l-7 7 7 7"/>
          </svg>
        </Link>
        <div style={{ width:38 }} />
        <div style={{ width:38 }} />
      </header>

      {/* Centre stage */}
      <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column',
        alignItems:'center', justifyContent:'center', zIndex:2, gap:28, padding:20,
        paddingTop:80, paddingBottom:200 }}>
        {/* Avatar + aura rings */}
        <div style={{ position:'relative', display:'grid', placeItems:'center' }}>
          {[0,1,2].map(i => (
            <div key={i} style={{ position:'absolute', width:300+i*40, height:300+i*40, borderRadius:'50%',
              border:'1px solid rgba(160,110,84,0.35)',
              animation: speaking ? `ax-ring 2.4s ease-out ${i*0.8}s infinite` : 'none',
              opacity: speaking ? 1 : 0.1 }} />
          ))}
          {hasCharImage
            ? <img src={bgSrc} alt={characterName} style={{ width:170, height:170, borderRadius:'50%', objectFit:'cover', position:'relative', zIndex:1,
                boxShadow:'0 0 60px rgba(0,0,0,0.7)', animation: speaking ? 'ax-breathe 2.6s ease-in-out infinite' : 'none' }} />
            : <div style={{ width:170, height:170, borderRadius:'50%', position:'relative', zIndex:1,
                background:'linear-gradient(155deg,#c9a882,#8c6e54)',
                display:'grid', placeItems:'center', fontSize:54, fontWeight:500, color:'#fbfaf6',
                boxShadow:'0 0 60px rgba(0,0,0,0.7)', animation: speaking ? 'ax-breathe 2.6s ease-in-out infinite' : 'none' }}>
                {(characterName||characterId)[0]}
              </div>}
        </div>

        {/* Name + status */}
        <div style={{ textAlign:'center' }}>
          <h2 style={{ fontSize:30, margin:'0 0 10px', fontWeight:600, color:'#fbfaf6', textShadow:'0 2px 12px rgba(0,0,0,0.6)' }}>{characterName||characterId}</h2>
          <div style={{ display:'inline-flex', alignItems:'center', gap:10, fontSize:14.5, color:'rgba(255,255,255,0.85)',
            background:'rgba(10,10,10,0.5)', border:'1px solid rgba(255,255,255,0.12)', padding:'8px 16px', borderRadius:6, backdropFilter:'blur(10px)' }}>
            {state==='connecting' || state==='waiting-agent' || state==='finalizing'
              ? <span className="ax-spin" style={{display:'grid'}}><svg viewBox="0 0 24 24" style={{width:15,height:15,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round'}}><circle cx="12" cy="12" r="8" strokeDasharray="38" strokeDashoffset="12"/></svg></span>
              : speaking
                ? <div style={{display:'flex',alignItems:'center',gap:4,height:22}}>{[0,1,2,3,4].map(i=><span key={i} style={{width:3,borderRadius:2,background:'#c2954e',animation:`ax-eq 0.9s ease-in-out ${i*0.12}s infinite`}}/>)}</div>
                : <span style={{width:7,height:7,borderRadius:'50%',background:'rgba(255,255,255,0.4)',display:'inline-block'}}/>}
            {stateLabel[state]}
            {inCall && <span style={{fontSize:12,color:'rgba(255,255,255,0.45)',fontVariantNumeric:'tabular-nums'}}>{String(min).padStart(2,'0')}:{String(sec).padStart(2,'0')}</span>}
          </div>
          <div style={{fontSize:10,color:'rgba(255,255,255,0.2)',marginTop:6,letterSpacing:1}}>v4.0 單機群聊 diarization (實驗)</div>
        </div>

        {/* Latest caption */}
        {captions.length > 0 && (
          <div style={{ maxWidth:320, textAlign:'center', fontSize:14, lineHeight:1.7, color:'rgba(255,255,255,0.6)', fontWeight:300 }}>
            {captions[captions.length-1].text}
          </div>
        )}
      </div>

      {/* Health pills */}
      <div style={{ position:'absolute', bottom:130, left:0, right:0, zIndex:3,
        display:'flex', justifyContent:'center', gap:7, flexWrap:'wrap', padding:'0 20px' }}>
        {HEALTH_ITEMS.map(h => (
          <div key={h.key} style={{ display:'flex', alignItems:'center', gap:7, fontSize:12, color:'rgba(255,255,255,0.7)',
            background:'rgba(10,10,10,0.5)', border:'1px solid rgba(255,255,255,0.1)', padding:'6px 11px', borderRadius:6, backdropFilter:'blur(8px)' }}>
            <span style={{ width:7, height:7, borderRadius:'50%', flexShrink:0, display:'inline-block',
              background: h.ok ? '#6f8c5f' : h.fail ? '#b5654a' : 'rgba(255,255,255,0.3)' }} />
          </div>
        ))}
      </div>

      {/* Controls */}
      <div style={{ position:'absolute', bottom:32, left:0, right:0, zIndex:3,
        display:'flex', justifyContent:'center', alignItems:'center', gap:18 }}>
        <CircleControl icon="mic-off" label={micMuted?'已靜音':'靜音'} onClick={toggleMic} active={micMuted} danger={micMuted} disabled={!inCall} />
        {canConnect
          ? <CircleControl icon="phone" label="接通" onClick={handleConnect} big primary />
          : <CircleControl icon="phone-off" label="掛斷" onClick={handleDisconnect} big hangup disabled={!canDisconnect} />}
        <div style={{ width:56 }} />
      </div>

      {/* Diag log */}
      {logOpen && (
        <div className="ax-enter" style={{ position:'absolute', right:18, bottom:110, width:320, maxHeight:260, zIndex:6,
          background:'rgba(10,10,10,0.88)', border:'1px solid rgba(255,255,255,0.12)', borderRadius:8, padding:14, backdropFilter:'blur(10px)',
          boxShadow:'0 20px 34px -20px rgba(0,0,0,0.6)' }}>
          <div style={{ fontSize:12.5, fontWeight:600, color:'rgba(255,255,255,0.4)', marginBottom:8 }}>診斷日誌 <span style={{fontSize:10,opacity:0.5}}>build:2026-06-10T14</span></div>
          <div style={{ fontSize:11, color:'rgba(255,255,255,0.5)', lineHeight:1.7, maxHeight:190, overflowY:'auto', fontFamily:'monospace' }}>
            {diagLogs.slice(-30).map((l,i)=>(
              <div key={i} style={{ color: l.level==='error'?'#f87171':l.level==='warn'?'#fbbf24':'rgba(255,255,255,0.4)' }}>{l.msg}</div>
            ))}
          </div>
        </div>
      )}

      {errorMsg && (
        <div style={{ position:'absolute', bottom:96, left:'50%', transform:'translateX(-50%)',
          fontSize:12, color:'#f87171', textAlign:'center', maxWidth:360, zIndex:3 }}>{errorMsg}</div>
      )}

      <audio ref={audioElRef} autoPlay playsInline
        onPlay={() => log('info', 'audio:play muted=' + (audioElRef.current?.muted ?? '?') + ' vol=' + (audioElRef.current?.volume ?? '?'))}
        onPause={() => log('info', 'audio:pause')}
      />
    </div>
  );
}
