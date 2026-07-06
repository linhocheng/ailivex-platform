/**
 * 語音引擎狀態（前台用，登入即可讀）
 * 只讀 Firestore 功能旗標，不碰 Cloud Run API——撥號頁載入時查一次，
 * 關閉時把「接通」鈕換成「現在無法撥號」，不讓用戶按了才碰壁。
 */
import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const snap = await getFirestore().collection('config').doc('voicePower').get();
  const on = snap.exists ? (snap.data() as { on?: boolean }).on !== false : true;
  return NextResponse.json({ on });
}
