# CLAUDE.md

Guidance for AI coding agents working in this repo. Written in English; domain terms are kept in the
team's Traditional Chinese (判斷腦, floor-gate, 回音過濾, 名冊, 一吋蛋糕) — match that vocabulary.

> ⚠️ **`README.md` is stale.** It documents voice versions v1–v4 and calls v2 "現役". Reality: the
> live agent is **v14**. Trust the **code and `git log`**, not the README, for current state.

---

## What this is

**ailiveX** — a **user-centric** AI-character memory + realtime-voice platform. Every
`(userId × characterId)` pair has its own private memory: the same character remembers different
things about different people. Memories / conversations / documents are **strictly bound to
`(userId, characterId)`** and never shared across users. (`src/lib/collections.ts` is the canonical
statement of this.)

Two user roles: **user** (front-of-house: lobby → text chat / voice call / documents) and **admin**
(back office: characters, users, access grants, memories, global prompts).

---

## Architecture

- **Web** — Next.js 16 (App Router) + React 19, deployed to **Vercel**. Serves all UI and `/api/*`.
  Node runtime; `cloud-run/` is excluded from the TS build.
- **Voice agent** — Python, LiveKit Agents `==1.5.1`, deployed to **Google Cloud Run, asia-east1**.
  One Cloud Run service per version, all built from a single shared Docker image.
- **doc-worker** — Node/Express on Cloud Run (**asia-east1**). **PRIMARY document path.** Source
  lives in a **separate repo**: `~/.ailive/ailivex-doc-worker` (github: linhocheng/ailivex-doc-worker)
  — NOT in this repo. `POST /` + `x-worker-secret`; 900s timeout (long bridge generations). Deploy:
  `bash scripts/deploy.sh` there. (The old us-central1 twin service + this repo's `cloud-run/doc-worker`
  copy were deleted 2026-07-04 — they were dead copies that received no traffic.)
- **Data** — Firestore (source of truth) + Google Cloud Storage (avatars, generated HTML). GCP
  project `ailivex-2026`.
- **External models** — LiveKit Cloud (WebRTC) · Soniox STT `stt-rt-v4` (diarization on) ·
  Anthropic Claude `claude-sonnet-4-6` (generation/docs/soul) + `claude-haiku-4-5-20251001`
  (gate/judgment/extraction) · MiniMax TTS `speech-2.6-hd` · Silero VAD · Vertex AI
  `text-embedding-004` (768-dim).

Live-voice flow:

```
browser  ──POST /api/livekit/token──▶  LiveKit JWT + RoomAgentDispatch{agentName=ailivex-realtime-vN}
   │                                    room: ailivex-<charId>-<userId>-<ts>
   │                                    metadata: {characterId,userId,convId,characterName,voiceId}
   ▼
LiveKit room  ◀──joins──  Cloud Run agent (the dispatched version)
   │                         └─ firestore_loader.build_system_prompt(soul + memory + lastSession)
   │                         └─ STT (Soniox) → LLM (Sonnet 4.6) → TTS (MiniMax) loop
   ▼
hangup  ──POST /api/voice-end──▶ relationship upsert
        └─ agent shutdown finalize (90s window): save transcript, lastSession snapshot, extract memories
```

---

## Repo layout

```
src/app/            Next.js App Router
  api/              all backend routes (dialogue, livekit/token, tts, voice-end, doc-process, admin/*, …)
  realtime*/        voice-call pages: realtime (base), realtime-v2 … realtime-v14  (NOTE: no v7; v2–v13 are archived, traffic goes to v14)
  chat/ lobby/ documents/ login/ admin/*
src/lib/            logic core (see cheat-sheet below)
agent/              ⭐ LIVE Python voice agents — versioned (main_vN.py, realtime_agent_vN.py, cloudbuild-vN.yaml)
                    shared modules: multi_party.py, minimax_tts.py, firestore_loader.py, conv_tuning.py
cloud-run/agent/    ⚠️ LEGACY snapshot of the BASE agent (309 lines, agent_name=ailivex-realtime). NOT live. Don't edit for current work.
scripts/            seed-admin.mts, reset-admin-pw.mjs, test-enqueue.mjs
docs/               design history (the WHY) — memory architecture, voice group/proactive plan, pages spec
```

---

## Voice-agent versioning — the central discipline

This is the most important thing to understand before touching voice code.

- **Every version is fully isolated**: its own `agent_name`, its own Cloud Run service
  (`ailivex-realtime-agent-vN`), its own frontend route (`/realtime-vN/[characterId]`), and its own
  `agent/cloudbuild-vN.yaml`. **Experiments NEVER touch the live version.** Rollback = simply don't
  route traffic to the new one.
- **All versions share one Docker image** (`asia-east1-docker.pkg.dev/$PROJECT_ID/ailivex/ailivex-realtime-agent`).
  They differ only by the start command `python -m agent.main_vN start` and the service name.
- **To add a version**: copy `main_v{N-1}.py` + `realtime_agent_v{N-1}.py` → `..._vN`, set
  `agent_name="ailivex-realtime-vN"`, add `cloudbuild-vN.yaml`, add a `/realtime-vN/` page, and add
  the `vN` branch in `src/app/api/livekit/token/route.ts`, **and the `<Link>` to `/realtime-vN/` in the
  version panel of `src/app/chat/[characterId]/page.tsx`** (else the page is unreachable except by typing the URL).
  In `cloudbuild-vN.yaml` the service name `ailivex-realtime-agent-vN` appears **twice** (the `run deploy` step
  AND the revision-cleanup bash step) — update both; the shared image path is version-less, don't rename it.

**Current production = v14.** Lineage (`src/lib/collections.ts` — `DEFAULT_VOICE_VERSION`):

| ver | agent_name | adds |
|---|---|---|
| base | `ailivex-realtime` | 1:1 voice |
| v2 | `ailivex-realtime-v2` | memory-coherent "2.0" (lastSession snapshot, time awareness) |
| v3 | `…-v3` | proactive speech (一吋蛋糕 / 3a) |
| v4 | `…-v4` | single-device group chat (Soniox diarization) |
| v5 | `…-v5` | yield-on-handoff (go silent when floor handed to a 3rd party) |
| v6 | `…-v6` | dual-brain: 判斷腦 Haiku (judge) / 開口腦 Sonnet (speak) |
| v8 | `…-v8` | floor control (grab mic when addressed / yield on handoff) |
| v9 | `…-v9` | LLM floor-gate (Haiku decides speaking rights) |
| v10 | `…-v10` | multi-party hardening: 回音過濾 (echo filter) / 講者名冊 (speaker roster) / 3a 收斂 |
| v11 | `…-v11` | voiceprint speaker ID (experimental, not in default traffic) |
| v12 | `…-v12` | 讀網址（通話中讀取 URL 摘要）|
| v13 | `…-v13` | task dispatch via voice (image / audio) |
| **v14** ★ | `…-v14` | script_draft + story_draft dispatch (LIVE — DEFAULT_VOICE_VERSION) |

> **No v7** — versions jump v6 → v8. The base agent is unversioned (`agent/main.py`,
> `agent/realtime_agent.py`).

---

## Data model (`src/lib/collections.ts` — authoritative)

Collections (all bound to `(userId, characterId)` unless noted):

- `users` — `username`, `passwordHash` (scrypt `salt:hash`), `displayName`, `role` (`user`|`admin`).
- `characters` — `soul` → `soulCore` (enhanced; injection prefers `soulCore`), `avatarUrl`,
  `voiceIdMinimax`, `voiceSettings`, `convSettings`, and `aliases` (read by the agent for floor-gate
  name variants). `status` (`active`|`archived`).
- `access` — allowlist; docId `${userId}_${characterId}` (existence = granted).
- `conversations` — docId `${userId}_${characterId}`; `messages[]` (`role`/`content`/`at`),
  `summary`, `messageCount`. The **agent also writes** `lastSession` + `messages[].speaker` (not in
  the TS interface).
- `memories` — `content`, `embedding` (768-dim), `importance` (1–10), `tier`, `type`, `status`,
  `hitCount`, `source`. **`tier` (`fresh`|`core`|`archive`) and `status`
  (`active`|`stale`|`resolved`) are different axes — do not conflate them.** 6 `type`s:
  `fact`/`emotion`/`preference`/`promise`/`question`/`milestone`.
- `relationships` — docId `${userId}_${characterId}`; `conversationCount`, first/last timestamps.
- `documents` — `title`, `mdContent`, `htmlUrl`, `slidesUrl`, `status`
  (`pending`→`writing`→`rendering`→`done`/`failed`).
- `jobs` — document-generation jobs (`brief`, `documentId`, `status`).
- `config/globalPrompts` — global prompt nodes (see gotchas). `zhu_vitals_cost` — LLM cost log.

---

## `src/lib` cheat-sheet

| module | responsibility |
|---|---|
| `firebase-admin.ts` | Firestore/Storage admin singleton (`getFirestore`, `getFirebaseAdmin`). |
| `collections.ts` | Collection names (`COL`) + all Firestore types. Source of truth for the schema. |
| `auth-session.ts` | HMAC-SHA256 signed `ailivex_session` cookie via Web Crypto (Edge+Node), 30-day, stateless. |
| `auth-password.ts` | scrypt `salt:hash` (Node-only; login/seed). |
| `session.ts` / `access.ts` | `getCurrentUser()` from cookie; `hasAccess()` checks the allowlist. |
| `conversation.ts` | Text history (`loadHistory` last **24**, `appendMessages` via arrayUnion). |
| `memory.ts` | 7-block memory prompt; dedup dual-threshold (cosine ≥0.9 AND CJK bigram ≥0.5, same type); fresh→core after **3** hits; stale (question 60d / emotion 90d); active-recall questions >7d; extraction via Haiku. |
| `relationship.ts` | `upsertRelationship` (increments count, updates lastConversationAt). |
| `diary.ts` | 角色日記（獨立空間，用戶不可見）：writeDiaryEntry (after conversation, Sonnet via bridge) + loadDiaryBlock (inject last 3 entries + unspoken + nextTime). Gated by `DIARY_CANARY_USERS` env (unset=off, `*`=all, else comma userIds). Composite index `diary(userId,characterId,createdAt)`. |
| `soul.ts` | `enhanceSoul()` — raw soul → 高密度 soulCore (Sonnet via bridge). |
| `embeddings.ts` | Vertex `text-embedding-004`, 768-dim; `cosineSimilarity`. |
| `anthropic-via-bridge.ts` | `getAnthropicClient()`: returns bridge if `BRIDGE_ENABLED`+`BRIDGE_URL`+`BRIDGE_SECRET`, else SDK. **A bridge runtime failure throws — no SDK fallback** (avoids double-billing). |
| `tool-tags.ts` | Parses `[[REMEMBER]]…[[/REMEMBER]]` and `[[DOCUMENT title="…"]]…[[/DOCUMENT]]` (text channel only — bridge has no tool_use). |
| `documents.ts` | `createDocumentJob` + `dispatchDocumentJob` (fire-and-forget). |
| `enqueue.ts` | ⚠️ **Deprecated** Cloud Tasks path — no-op when env unset. |
| `url-reader.ts` | SSRF-guarded link reading (≤2 urls, 3500 chars; blocks private IPs / cloud metadata / redirects). |
| `cost-tracker.ts` | Writes a usage row to `zhu_vitals_cost` (estimate only; bridge = flat fee). |

---

## Key flows

**Text dialogue** (`src/app/api/dialogue/route.ts`): auth → `hasAccess` (admin bypasses) → soul
(`soulCore`→`soul`) + `loadMemoryBlock(query=message)` + `loadHistory(24)` + `readUrlsForContext`
→ `getAnthropicClient` (**bridge-preferred**) Sonnet 4.6 → `parseToolTags` → write memories
(`tool:remember`) + create doc jobs → `appendMessages` → `after()` (post-response): extract memories
+ upsert relationship + dispatch doc jobs → `trackCost`.

**Voice** (`agent/realtime_agent_v14.py`): the turn-path Sonnet 4.6 uses the **direct
`ANTHROPIC_API_KEY`** (bridge can't stream and lacks tool_use). The **off-path** calls — 判斷腦
(`_run_inner_judgment`, Haiku), 3a proactive speech, and shutdown memory/lastSession extraction — are
**bridge-preferred with direct fallback**. Tools are native `@function_tool` (`remember`,
`write_document`). Multi-party hardening: echo filter (drop the agent's own TTS heard back), speaker
roster (`#N` → learned name), and 3a 收斂 (in groups, speak only when 判斷腦 says
`want_to_speak`, not merely on silence).

**Document generation**: text `[[DOCUMENT]]` or voice `write_document` → `jobs` + `documents` rows →
dispatch `{jobId}` with `x-worker-secret` → **primary path = Cloud Run doc-worker (`POST /`, separate
repo, asia-east1)** — `CLOUD_RUN_DOC_WORKER_URL` takes priority in `dispatchDocumentJob`; Vercel
`/api/doc-process` is the fallback when that env is unset (bridge Sonnet 8192 tokens → 簡→繁 →
text-filter → `marked` → styled HTML → GCS public URL; retryable error → 500 + status `pending`,
else → `failed`). Both exits apply the output chain 轉繁 → 句型過濾 → 轉繁. Cloud Tasks is deprecated. Download: PDF via `puppeteer-core`+`@sparticuz/chromium`, PPT via `pptxgenjs`
(`/api/documents/[id]/pdf|ppt`).

**Memory prompt**: `build_system_prompt` (Python `agent/firestore_loader.py`, mirrored by TS
`src/lib/memory.ts`) → soul + global prompts + Taipei time + 【關係】 + 6 memory blocks +
【上次對話】lastSession snapshot + raw last-6-message tail (接話 continuity, not a summary recital).

---

## Auth

scrypt password hash; HMAC-signed httpOnly `ailivex_session` cookie (Web Crypto so it runs in both
Edge middleware and Node routes; 30-day; stateless — no DB lookup). `src/middleware.ts` gates every
path except `/login`, `/api/auth/login`, `/api/doc-process`, and restricts `/admin*` + `/api/admin*`
to admins. **Backends always re-check `hasAccess`** — UI hiding is not security.

---

## Commands

```bash
# Local web
npm run dev            # next dev
npm run build          # next build
npm run start          # next start (prod build)
npm run lint           # eslint

# Deploy web (Vercel)
npx vercel --prod --yes

# Deploy a voice agent version (Cloud Build → Cloud Run)
gcloud builds submit --config=agent/cloudbuild-vN.yaml --substitutions=COMMIT_SHA=<sha> .

# Run a voice agent locally
python -m agent.main_vN dev

# Admin scripts
npx tsx --env-file=.env.local scripts/seed-admin.mts <username> <password> [displayName]
node scripts/reset-admin-pw.mjs [password]
```

---

## Environment & secrets

Secrets live in **GCP Secret Manager** and are injected at deploy (see `agent/cloudbuild-v14.yaml`).
**Never commit `.env*`.** Keys referenced across the codebase:

- Firebase/GCP: `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_PROJECT_ID`
- LiveKit: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- Models: `SONIOX_API_KEY`, `ANTHROPIC_API_KEY`, `MINIMAX_API_KEY`, `MINIMAX_GROUP_ID`, `MINIMAX_DEFAULT_VOICE_ID`
- Bridge (Claude Max OAuth, flat fee): `BRIDGE_ENABLED`, `BRIDGE_URL`, `BRIDGE_SECRET`
- Misc: `SESSION_SECRET` (cookie signing), `WORKER_SECRET` (doc-process auth), `PROJECT_NAMESPACE`
  (room-name prefix, default `ailivex`), doc dispatch `CLOUD_RUN_DOC_WORKER_URL` (web) / `DOC_WORKER_URL` (agent)

---

## Conventions & gotchas

- **Commits**: version-prefixed Traditional Chinese — `vN.N.N 修正：…` / `vN.N 新增：…` (matches the
  entire git history). **Only commit when explicitly asked.** No co-author / generated-by footers.
- **Voice versions are append-only & isolated** — never edit the live version to experiment; copy to
  a new vN (see the versioning section).
- **"Isolated" has exceptions — these are SHARED by all versions**: `agent/firestore_loader.py`,
  `multi_party.py`, `conv_tuning.py`, and `requirements.txt`/`Dockerfile` (one image). Edit them
  **additively / back-compat** (a new optional param defaulting to old behavior) or you change/break
  v1–v{N-1}. A bad dependency pin in `requirements.txt` breaks the **production** image for every version —
  validate the Cloud Build before routing traffic.
- **LiveKit plugins are pinned `==1.5.1`** (`agent/requirements.txt`) — version drift causes a
  `ChunkedStream` crash. Don't bump casually. MiniMax uses a **custom wrapper** because the official
  plugin is incompatible with 1.5.x.
- **`agent/` is live; `cloud-run/agent/` is a legacy snapshot** of the base agent — don't confuse them.
- **Split LLM routing** — text paths and voice off-path are **bridge-preferred**
  (`getAnthropicClient` / `BRIDGE_URL`); the voice **turn-path is always the direct paid key**. Bridge
  has **no streaming and no tool_use** — that's why text tools use `[[…]]` markers and voice uses
  native function tools.
- **Dual-brain 天條** — judgment → Haiku, but the **go/no-go decision is deterministic code**
  (`conv_tuning.should_grab_floor`, `parse_inner_state`, the floor-gate); generation → Sonnet.
  "機制不丟 LLM": debounce / turn-gate / cooldown / parsing stay in code; the LLM only scores or drafts.
- **Global prompts are duplicated** — defaults exist in BOTH `agent/firestore_loader.py`
  (`DEFAULT_GLOBAL_PROMPTS`) and the admin TS route, overridden by Firestore `config/globalPrompts`.
  Change one → change the other.
- **TTS hardening** — text is converted 繁→簡 (opencc) before MiniMax; WebSocket streaming with a
  REST SSE fallback so the voice never goes silent.
- **Deprecated**: the `enqueue.ts` Cloud Tasks path. Cost logs go to `zhu_vitals_cost` (shared with
  the "zhu"/bridge ecosystem).
- **Models** (per global guidance, latest): Sonnet 4.6 / Haiku 4.5. `docs/` captures the design
  reasoning (the WHY); it is not a description of current state.
```
