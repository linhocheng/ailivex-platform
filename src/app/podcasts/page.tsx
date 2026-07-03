'use client';

/**
 * Podcast 素材收集頁（客戶端）— 當前用戶所有完成的 Podcast 腳本與音檔
 */
import { useEffect, useState } from 'react';
import { Ambient } from '@/app/_components/ui';
import { FrontNav } from '@/app/_components/FrontNav';
import { PodcastLibrary } from '@/app/_components/PodcastLibrary';

export default function PodcastsPage() {
  const [chars, setChars] = useState<Array<{ id: string; name: string }>>([]);
  const [charsLoaded, setCharsLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/convert/characters')
      .then(r => r.json())
      .then(r => { setChars(r.characters || []); setCharsLoaded(true); })
      .catch(() => setCharsLoaded(true));
  }, []);

  return (
    <>
      <Ambient />
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
        <FrontNav active="podcasts" />
        <main style={{ flex: 1, overflowY: 'auto', padding: '40px clamp(20px,5vw,64px) 64px' }}>
          <div style={{ maxWidth: 940, margin: '0 auto' }}>
            <div style={{ marginBottom: 28 }} className="ax-enter">
              <h1 style={{ fontSize: 30, margin: 0, fontWeight: 600, letterSpacing: '-0.02em' }}>Podcast 素材</h1>
              <p style={{ fontSize: 14.5, color: 'var(--muted)', margin: '7px 0 0' }}>
                你生成過的 Podcast 腳本與音檔都收集在這裡，可編輯、可下載
              </p>
            </div>
            {charsLoaded && <PodcastLibrary chars={chars} refreshSignal={0} showEmpty />}
          </div>
        </main>
      </div>
    </>
  );
}
