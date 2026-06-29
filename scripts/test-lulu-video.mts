/**
 * MVP test: Lulu character → MiniMax TTS → GCS → HeyGen video
 * Run: npx tsx --env-file=.env.local scripts/test-lulu-video.mts
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Load .env.local manually (--env-file can't handle JSON with inner quotes) ──
function loadEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

// ── Firebase init ──────────────────────────────────────────────────────────
function initFirebase() {
  if (getApps().some((a) => a.name === "[DEFAULT]")) return;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not set");
  const sa = JSON.parse(saJson);
  initializeApp({
    credential: cert(sa),
    projectId: sa.project_id,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

// ── Script & motion ────────────────────────────────────────────────────────
const SCRIPT = `大家好，我是 Lulu！豆油伯是一個來自雲林的在地品牌，堅持用最傳統的日曬工藝釀造醬油。每一瓶都是時間的味道，每一滴都是匠人的心意。如果你也在乎食材的來源，那你一定要試試豆油伯。`;

const MOTION_PROMPT = "raise one hand and point index finger directly at the camera while speaking confidently";

// ── MiniMax TTS ────────────────────────────────────────────────────────────
async function generateAudio(text: string, voiceId: string, voiceSettings: Record<string, unknown>): Promise<Buffer> {
  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!apiKey || !groupId) throw new Error("MINIMAX_API_KEY or MINIMAX_GROUP_ID not set");

  // 繁 → 簡（TTS 音準要求）
  const { Converter } = await import("opencc-js");
  const toSimplified = Converter({ from: "tw", to: "cn" });
  const simplified = toSimplified(text);

  console.log("🎙  Generating audio via MiniMax...");
  const resp = await fetch(`https://api.minimax.io/v1/t2a_v2?GroupId=${groupId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "speech-2.6-hd",
      text: simplified,
      stream: false,
      voice_setting: {
        voice_id: voiceId,
        speed: (voiceSettings.speed as number) ?? 1.0,
        vol: (voiceSettings.vol as number) ?? 1.0,
        pitch: (voiceSettings.pitch as number) ?? 0,
        emotion: (voiceSettings.emotion as string) ?? "happy",
      },
      audio_setting: { output_format: "mp3", sample_rate: 32000, bitrate: 128000 },
    }),
  });

  if (!resp.ok) throw new Error(`MiniMax ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { base_resp?: { status_code: number; status_msg: string }; data?: { audio: string } };
  if (data.base_resp?.status_code !== 0) throw new Error(`MiniMax error ${data.base_resp?.status_code}: ${data.base_resp?.status_msg}`);
  const hex = data.data?.audio;
  if (!hex) throw new Error("No audio data in MiniMax response");
  return Buffer.from(hex, "hex");
}

// ── GCS upload ─────────────────────────────────────────────────────────────
async function uploadToGcs(bytes: Buffer, filename: string): Promise<string> {
  const storage = getStorage();
  const bucket = storage.bucket();
  const filePath = `media-worker/test/${filename}`;
  const file = bucket.file(filePath);
  await file.save(bytes, { contentType: "audio/mpeg" });
  const url = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
  console.log(`📦  Audio uploaded: ${url}`);
  return url;
}

// ── HeyGen video ───────────────────────────────────────────────────────────
async function generateHeyGenVideo(avatarUrl: string, audioUrl: string): Promise<string> {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) throw new Error("HEYGEN_API_KEY not set");

  console.log("🎬  Creating HeyGen video (avatar_id mode)...");
  const createResp = await fetch("https://api.heygen.com/v3/videos", {
    method: "POST",
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "avatar",
      title: "lulu-douybuer-avatar-test",
      resolution: "1080p",
      aspect_ratio: "auto",
      avatar_id: "f987bd3ce34047c08d356930a409b184",
      audio_url: audioUrl,
      engine: { type: "avatar_iv" },
      expressiveness: "high",
      motion_prompt: MOTION_PROMPT,
    }),
  });

  if (!createResp.ok) {
    const err = await createResp.text();
    throw new Error(`HeyGen create ${createResp.status}: ${err.slice(0, 400)}`);
  }

  const createData = await createResp.json() as { data: { video_id: string } };
  const videoId = createData.data?.video_id;
  if (!videoId) throw new Error("HeyGen: no video_id in response");
  console.log(`⏳  Video ID: ${videoId} — polling...`);

  // Poll up to 6 minutes
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 8000));
    const statusResp = await fetch(`https://api.heygen.com/v3/videos/${videoId}`, {
      headers: { "X-Api-Key": apiKey },
    });
    if (!statusResp.ok) continue;
    const statusData = await statusResp.json() as { data: { status: string; video_url: string | null; error?: string | null } };
    const { status, video_url, error } = statusData.data;
    console.log(`   status: ${status}`);
    if (status === "completed" && video_url) return video_url;
    if (status === "failed") throw new Error(`HeyGen failed: ${error ?? "unknown"}`);
  }
  throw new Error("HeyGen timed out after 6 minutes");
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  initFirebase();
  const db = getFirestore();

  // 找 Lulu 角色
  console.log("🔍  Looking for Lulu in Firestore...");
  const snap = await db.collection("characters")
    .where("status", "==", "active")
    .get();

  const lulu = snap.docs.find(d => {
    const name = (d.data().name as string ?? "").toLowerCase();
    return name.includes("lulu") || name.includes("露露");
  });

  if (!lulu) {
    const names = snap.docs.map(d => d.data().name).join(", ");
    throw new Error(`Lulu not found. Active characters: ${names}`);
  }

  const data = lulu.data();
  console.log(`✅  Found: ${data.name} (id: ${lulu.id})`);
  console.log(`   avatarUrl: ${data.avatarUrl}`);
  console.log(`   heygenAvatarUrl: ${data.heygenAvatarUrl}`);
  console.log(`   heygenAvatarId: ${data.heygenAvatarId}`);
  console.log(`   voiceId: ${data.voiceIdMinimax}`);

  const avatarUrl = data.avatarUrl || data.heygenAvatarUrl;
  if (!avatarUrl) throw new Error(`Lulu has no avatarUrl or heygenAvatarUrl. Fields: ${Object.keys(data).join(", ")}`);
  if (!data.voiceIdMinimax) throw new Error("Lulu has no voiceIdMinimax");

  // TTS
  const audioBytes = await generateAudio(SCRIPT, data.voiceIdMinimax, data.voiceSettings ?? {});
  console.log(`   Audio size: ${audioBytes.length} bytes`);

  // Upload
  const audioUrl = await uploadToGcs(audioBytes, `lulu-test-${Date.now()}.mp3`);

  // HeyGen
  const videoUrl = await generateHeyGenVideo(avatarUrl, audioUrl);

  console.log("\n🎉  Video ready!");
  console.log(`   ${videoUrl}`);

  // Download to ~/Downloads
  const { writeFileSync } = await import("fs");
  const { homedir } = await import("os");
  const outPath = `${homedir()}/Downloads/lulu-douybuer-test.mp4`;
  console.log(`\n⬇️   Downloading to ${outPath}...`);
  const dlResp = await fetch(videoUrl);
  if (!dlResp.ok) throw new Error(`Download failed: ${dlResp.status}`);
  const buf = Buffer.from(await dlResp.arrayBuffer());
  writeFileSync(outPath, buf);
  console.log(`✅  Saved (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
