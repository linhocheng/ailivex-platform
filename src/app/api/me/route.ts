import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ uid: user.uid, role: user.role, name: user.name });
}
