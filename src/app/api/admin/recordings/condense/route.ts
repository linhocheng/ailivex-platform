/**
 * 產生錄音濃縮版（去空白）。POST ?room=<roomName>
 *
 * 原始檔不動（訪談錄音是證據），另存 *.condensed.mp4。
 * ffmpeg silenceremove 是確定性處理；同步跑完才回應（GCS 下載→轉檔→上傳，
 * 分鐘級音檔約數秒，maxDuration=300 足夠長訪談）。冪等：重按就重產覆蓋。
 */
import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import ffmpegPath from 'ffmpeg-static';
import { getFirebaseAdmin, getFirestore } from '@/lib/firebase-admin';
import { COL, type RecordingDoc } from '@/lib/collections';
import { condensedFilepath, SILENCE_REMOVE_FILTER } from '@/lib/recording';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const execFileAsync = promisify(execFile);

export async function POST(req: Request) {
  const room = new URL(req.url).searchParams.get('room')?.trim();
  if (!room || !/^[\w-]+$/.test(room)) {
    return NextResponse.json({ error: 'room 必填（英數-_）' }, { status: 400 });
  }
  if (!ffmpegPath) {
    return NextResponse.json({ error: 'ffmpeg 不可用' }, { status: 500 });
  }

  const db = getFirestore();
  const ref = db.collection(COL.recordings).doc(room);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: '不存在' }, { status: 404 });
  const r = snap.data() as RecordingDoc;
  if (r.status !== 'done') return NextResponse.json({ error: '錄音尚未完成' }, { status: 409 });

  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) return NextResponse.json({ error: 'FIREBASE_STORAGE_BUCKET 未設定' }, { status: 500 });
  const bucket = getFirebaseAdmin().storage().bucket(bucketName);

  const src = join(tmpdir(), `${room}.src.mp4`);
  const dst = join(tmpdir(), `${room}.condensed.mp4`);
  try {
    await bucket.file(r.filepath).download({ destination: src });
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', src,
      '-af', SILENCE_REMOVE_FILTER,
      '-c:a', 'aac', '-b:a', '96k',
      dst,
    ]);

    const outPath = condensedFilepath(r.filepath);
    await bucket.upload(dst, { destination: outPath, contentType: 'video/mp4', resumable: false });
    const [meta] = await bucket.file(outPath).getMetadata();
    const condensedSizeBytes = Number(meta.size) || 0;

    await ref.update({ condensedFilepath: outPath, condensedSizeBytes });
    return NextResponse.json({ ok: true, condensedFilepath: outPath, condensedSizeBytes });
  } catch (e) {
    console.error('[recordings/condense] 失敗:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: '濃縮失敗，原始檔不受影響' }, { status: 500 });
  } finally {
    await unlink(src).catch(() => {});
    await unlink(dst).catch(() => {});
  }
}
