'use client';

import { useRouter } from 'next/navigation';
import type { CSSProperties, ReactNode } from 'react';

export function LogoutButton({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  const router = useRouter();
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    router.push('/login');
    router.refresh();
  }
  return (
    <button onClick={logout} style={style}>
      {children ?? '登出'}
    </button>
  );
}
