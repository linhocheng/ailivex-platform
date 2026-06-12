import { NextResponse } from 'next/server';
import { enhanceSoul } from '@/lib/soul';

export const runtime = 'nodejs';
export const maxDuration = 120;

// 預覽：原始靈魂 → soulCore（管理者存檔前可先看）
export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { name?: string; soul?: string } | null;
  const name = body?.name?.trim();
  const soul = body?.soul?.trim();
  if (!name || !soul || soul.length < 10) {
    return NextResponse.json({ error: '角色名與靈魂（至少 10 字）必填' }, { status: 400 });
  }
  const soulCore = await enhanceSoul(name, soul);
  return NextResponse.json({ soulCore });
}
