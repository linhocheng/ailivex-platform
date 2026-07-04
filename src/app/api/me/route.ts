import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/session';
import { getFirestore } from '@/lib/firebase-admin';
import { getQuota } from '@/lib/quota';

export const runtime = 'nodejs';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // 誠實中台：把用量帶給前台，用戶看得到自己剩多少（admin 不受管制，quota 全 null）
  const quota = user.role === 'admin'
    ? { voiceSecondsLimit: null, voiceSecondsUsed: 0, voiceSecondsRemaining: null, docsLimit: null, docsUsed: 0, docsRemaining: null, mediaLimit: null, mediaUsed: 0, mediaRemaining: null, textLimit: null, textUsed: 0, textRemaining: null }
    : await getQuota(getFirestore(), user.uid).catch(() => null);
  return NextResponse.json({ uid: user.uid, role: user.role, name: user.name, quota });
}
