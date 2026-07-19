/**
 * Firestore collection 名稱 + 資料模型型別（單一真相源）
 *
 * ailiveX 的核心翻轉：以「用戶」為中心，不是以「角色」為中心。
 * memories / conversations / documents 一律嚴格綁 (userId, characterId)。
 * 角色不共享記憶 —— 同一個角色對不同用戶各記各的。
 */

export const COL = {
  users: 'users',
  characters: 'characters',
  access: 'access',
  conversations: 'conversations',
  memories: 'memories',
  relationships: 'relationships',
  diary: 'diary',
  impressions: 'impressions',
  documents: 'documents',
  jobs: 'jobs',
  tasks: 'tasks',
  brandLayouts: 'brand_layouts',
  brandProducts: 'brand_products',
  knowledgeDocs: 'knowledge_docs',
  knowledgeChunks: 'knowledge_chunks',
  knowledgeProposals: 'knowledge_proposals',
  methodologies: 'methodologies',
  recordings: 'recordings',
  memoryHealthRuns: 'memory_health_runs',
} as const;

export type UserRole = 'user' | 'admin';

export interface UserDoc {
  username: string;
  passwordHash: string;   // scrypt: salt:hash (hex)
  displayName: string;
  role: UserRole;
  createdAt: FirebaseFirestore.Timestamp | Date;
  // ── 用量管制（總量制，user 層、全角色共用；缺省 = 不限）──
  // used 只加不減（可溯；加額度只改 limit）；歸零靠 admin 重置
  voiceSecondsLimit?: number;  // 即時語音總秒數上限
  voiceSecondsUsed?: number;
  docsLimit?: number;          // 文件生成總份數上限
  docsUsed?: number;
  mediaLimit?: number;         // 媒體生成（圖片/影片/音檔）總份數上限
  mediaUsed?: number;
  textLimit?: number;          // 文字對話總則數上限（以 user 訊息數計）
  textUsed?: number;
}

export type CharacterStatus = 'active' | 'archived';

export interface VoiceSettings {
  speed?: number;    // 0.5–2.0，預設 1.0
  pitch?: number;    // −12 ~ +12，預設 0
  vol?: number;      // 0.1–3.0，預設 1.0
  emotion?: string;  // neutral / happy / sad / angry / fearful / surprised / disgusted
}

export interface ConvSettings {
  responseSpeed?: number;        // 1–5 接話速度（5=秒回）
  interruptSensitivity?: number; // 1–5 被打斷敏感度（5=一出聲就停）
  imThreshold?: number;          // 1–5 主動程度（即時語音 2.0 冷場開口）
  interruptThreshold?: number;   // 1–5 搶話程度（切進別人的話，群聊用）
  temperature?: number;          // 0.1–1.0 LLM 溫度（越低越收斂/越不演）
}

export type TaskCapability = 'image_generation' | 'audio_generation' | 'writing' | 'web_search' | 'script_draft' | 'story_draft' | 'video_generation' | 'podcast_generation';

/**
 * persona.voice —「他說話的樣子」（Podcast 雙人對談 Voice Layer 用，正向描述不是禁止清單）。
 * 消費端：cloud-run/podcast-worker 的 SPEAK pass；空缺欄位 = 該面向不個人化。
 */
export interface CharacterVoiceProfile {
  rhythm?: string;            // 句子長短、快慢、會不會講完
  habits?: string;            // 慣用開場、慣用結尾
  evidenceStyle?: string;     // 怎麼舉證：例子？數字？人名？
  whenUncertain?: string;     // 不知道的時候會怎樣
  forbiddenRegister?: string; // 角色專屬禁區（與全平台 MOVE 規則疊加）
}

export interface PodcastLine {
  speaker: string;
  characterId: string;
  text: string;
}

export interface CharacterDoc {
  name: string;
  soul: string;            // 靈魂（單一真相；舊 soulCore 已於 2026-07-03 遷移合併，淘汰版備份在 soulLegacy）
  expression?: string[];   // 表達層——soul 外掛：慣用語/情境說法，無條件全文注入（不走檢索不衰減）；admin 對話 [[EXPRESSION]] 或後台維護，上限見 expression.ts
  avatarUrl: string;
  voiceIdMinimax?: string; // 即時語音用
  voiceSettings?: VoiceSettings;
  convSettings?: ConvSettings;  // 對話手感旋鈕
  aliases?: string[];      // 角色別名，多人房 deterministic target resolver 用
  voice?: CharacterVoiceProfile; // 說話的樣子（podcast duo Voice Layer；admin 角色頁可編輯）
  capabilities?: TaskCapability[];  // 允許呼叫的工廠能力，缺省 = 空陣列
  imageStyle?: string;     // 圖片生成風格描述（story_draft 生圖 prompt prefix）
  heygenAvatarId?: string;    // HeyGen talking_photo_id（avatar_iv 引擎）
  heygenAvatarIdV3?: string;  // HeyGen talking_photo_id（avatar_iii 引擎，需分開訓練）
  heygenAvatarUrl?: string;  // HeyGen 上傳後的預覽 URL（v3 image 欄位用）
  // ── 知識庫／方法論開關（角色 doc 每輪必讀，缺省/0 = 該路徑完全不走，零額外讀）──
  // 由 admin knowledge/methodologies routes 確定性維護（增刪時 increment/遞減），不靠 LLM。
  knowledgeChunkCount?: number;   // 該角色 active 知識塊總數
  methodologyCount?: number;      // 該角色 active 方法論總數
  methodProposalEnabled?: boolean; // 方法論共創試驗閘：開了之後 admin 對話會教角色 [[PROPOSE_METHOD]] 提案（落 draft，審核轉正才生效）
  recordingEnabled?: boolean;     // 對話錄音（LiveKit Egress 混流 → GCS；私人使用，缺省 = 關）
  status: CharacterStatus;
  createdAt: FirebaseFirestore.Timestamp | Date;
}

// ── 對話錄音（LiveKit Egress）──
// docId = roomName（每通唯一）。token route 建房掛 auto egress 時同步開帳；
// egress_ended webhook 或 admin 列表 reconcile 收帳。
export type RecordingStatus = 'recording' | 'done' | 'failed';

export interface RecordingDoc {
  roomName: string;
  characterId: string;
  characterName: string;
  userId: string;
  filepath: string;        // GCS object path（建房時即確定）
  status: RecordingStatus;
  egressId?: string;       // webhook/reconcile 回填
  durationSec?: number;
  sizeBytes?: number;
  createdAt: FirebaseFirestore.Timestamp | Date;
  endedAt?: FirebaseFirestore.Timestamp | Date;
  // 濃縮版（去空白）：ffmpeg silenceremove 另存，原始檔不動
  condensedFilepath?: string;
  condensedSizeBytes?: number;
}

// ── 記憶健康巡檢（觀察者）──────────────────────────────────────────────────
export type MemoryHealthStatus = 'ok' | 'warn' | 'fail';
export type MemoryHealthSeverity = 'fail' | 'warn' | 'info';

export interface MemoryHealthFinding {
  severity: MemoryHealthSeverity;
  kind: string;          // orphan / missing-field / backlog / consolidation-stuck / embedding-drift …
  detail: string;        // 人話描述
  count?: number;
  ids?: string[];        // 涉及的 doc id（最多留 20 個，夠追查就好）
}

export interface MemoryHealthRunDoc {
  triggeredAt: FirebaseFirestore.Timestamp | Date;
  trigger: 'cron' | 'manual';
  status: MemoryHealthStatus;   // 有 fail 級發現 = fail；有 warn = warn；否則 ok
  durationMs: number;
  summary: {
    total: number;
    byTier: Record<string, number>;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    pairs: number;               // (userId × characterId) 配對數
    impressions: number;
    orphans: number;
    probe: { sampled: number; drifted: number; avgSelfCos: number | null };
  };
  findings: MemoryHealthFinding[];
  // 管線 canary 現況快照（env 真相，後台才看得到誰吃哪套管線）
  pipelines: { impressions: string; gist: string; diary: string };
  observerComment: string | null;  // 記憶觀察者（LLM）讀確定性結果寫的診斷評語；失敗不影響巡檢
}

export interface AccessDoc {
  userId: string;
  characterId: string;
  voiceVersion?: string;   // 指派的語音 agent 版本（VOICE_VERSIONS.id）；缺省 = 全域預設
  gptVoiceEnabled?: boolean;  // GPT Voice 線開關（獨立第二條通話線）；admin 恆可不看此欄
  grantedAt: FirebaseFirestore.Timestamp | Date;
}

/**
 * 語音 agent 版本登錄表 —— 單一真相源。
 * 只登錄「活著的服務」與「冷備」：
 *   - 無 standby 旗標＝現役，可被 access.voiceVersion 指派、可接真實通話。
 *   - standby: true＝冷備（服務降 0，LiveKit agent 降 0＝聾）：留在登錄表是為了回滾路徑，
 *     但 agentNameForVersion 一律把它解析成 DEFAULT——殘留的 canary 釘選在物理上打不到聾服務。
 *     （教訓 2026-07-15：v18 轉正沒清 v17 canary 釘選，Adam 的 tracy/Lilith 派工到 0 實例服務變死通話。
 *     顯式狀態不隨預設值走——防禦釘在 agentNameForVersion 這個唯一咽喉，不靠人記得清資料。）
 *     回滾 SOP：先 scale up min=1 → 拿掉 standby 旗標 → 切 DEFAULT。
 * 退役版本一律移出登錄表（未知版本 agentNameForVersion 也安全回落 DEFAULT）。
 * 頁面路由只有 /realtime/（2026-07-10 殼頁全清）。
 *
 * 版本迭代歷史（封存備查；服務降 0 保留在 Cloud Run，重啟需先 scale up）：
 *   base  基礎 1:1 語音對話
 *   v2    記憶連貫（lastSession 快照、時間感知）
 *   v3    主動發話（3a 一吋蛋糕實驗；2026-07-10 於 v17.4 整組退役）
 *   v4    單機群聊（Soniox diarization 多人辨識）
 *   v5    讓位偵測（偵測發話對象，交棒第三方時靜音）
 *   v6    雙腦架構（判斷腦 Haiku / 開口腦 Sonnet）
 *   v8    發言權控制（抓麥克風、讓位機制）        ← 無 v7
 *   v9    LLM 發言權判斷（Haiku 決定搶話時機）
 *   v10   多人硬化（回音過濾、講者名冊、3a 收斂）
 *   v11   聲紋講者辨識（voiceprint 分群實驗，未正式上線）
 *   v12   讀網址（通話中貼網址讓角色讀取摘要）
 *   v13   任務派發（語音下指令生圖 / 生音檔）
 *   v14   腳本草稿 + 音檔生成（dispatch_task script_draft）
 *   v15   記憶對等（embedding/dedup/hitCount）+ 通話中動態想起
 *   v16   語音延遲優化（VAD prewarm + min_silence 0.3 + TTS 首段 flush）＋v16.5 3a 防護——2026-07-10 收案降 0
 *   v17   ★ LIVE — 記憶全景圖語音道（remote 記憶塊＋掛斷日記）；v17.4 移除 3a
 *   v18   打斷音量閘（重設計版：只攔 pause 不碰 commit；讓位層舊版資產在 git 4993b28）
 */
/**
 * 訓練線（共創高我線）—— 第二線插座的現任使用者（前任 GPT Voice 已退役）。
 * 定位：admin 訓練師直通角色底層的共創通話（提案方法論/知識）；永不取代 DEFAULT——
 * 兩線長期並存，一般用戶不知道它存在。
 * 閘門：token route 驗 admin ＋ characters.methodProposalEnabled 雙閘（UI 隱藏不是安全）。
 * 服務費用掛在語音電源開關傘下（voice-power CANARY_VOICE_VERSIONS）。
 */
export const TRAINER_VOICE_LINE = {
  id: 'trainer',
  label: '共創',
  agentName: 'ailivex-realtime-v19',
} as const;

export const VOICE_VERSIONS = [
  { id: 'v17', label: '17',   agentName: 'ailivex-realtime-v17', standby: true },  // 冷備已降 0（聾）：只當回滾坑位，永不被派工
  { id: 'v18', label: '18',   agentName: 'ailivex-realtime-v18', standby: false }, // 熱回滾坑位（min=1 保留數日；穩定後降 0 掛 standby）——打斷音量閘版
  { id: 'v19', label: '19',   agentName: 'ailivex-realtime-v19', standby: false }, // 訓練線（= v18 + propose_* 提案工具 + 檢索/遞招運行時）：TRAINER_VOICE_LINE 專用，不進一般派工輪替
  { id: 'v20', label: '20',   agentName: 'ailivex-realtime-v20', standby: false }, // ★ LIVE — 知識檢索＋方法論遞招運行時（v19.1 訓練線驗收→canary→2026-07-19 轉正；無提案工具）
] as const;

export const DEFAULT_VOICE_VERSION = 'v20';  // 2026-07-19 轉正：知識檢索＋遞招運行時（canary 實測過）；v18 留熱回滾（min=1，觀察幾天後降冷備）

/** 可被指派／派工的現役版本（standby 冷備排除） */
export const ACTIVE_VOICE_VERSIONS = VOICE_VERSIONS.filter(v => !v.standby);

/**
 * GPT Voice 線 —— 獨立第二條通話線，不在 vN 系譜裡。
 * 配線：gpt-realtime 聽＋想（text-only 輸出）→ MiniMax 發聲（角色聲音照舊）。
 * 派工靠 token route 的 line:'gpt' + access.gptVoiceEnabled（admin 恆可），與 voiceVersion 互不干涉。
 * 服務：Cloud Run ailivex-realtime-agent-gpt（agent/main_gpt.py，cloudbuild-gpt.yaml）。
 *
 * ★ 2026-07-16 一晚 POC 後判負退役（retired: true）：底模身份訓練輾過角色靈魂（直問即自報
 * ChatGPT）＋VAD 幻聽。完整證據與可取之處見 docs/gpt_voice_line_retrospective_20260716.md。
 * retired 同時關兩個閘：前台按鈕（characters/[id]）＋token 派工（服務已降 0＝聾，放行=死通話）。
 * 復活 SOP：服務 scale up → retired 改 false → 部署 web。
 */
export const GPT_VOICE_LINE = { id: 'gpt', label: 'GPT', agentName: 'ailivex-realtime-gpt', retired: true } as const;

/** 版本 id → LiveKit agentName。未知/缺省/standby 冷備 → 全域預設版本（冷備＝0 實例＝聾，派過去是死通話）。 */
export function agentNameForVersion(version?: string): string {
  const fallback = VOICE_VERSIONS.find(v => v.id === DEFAULT_VOICE_VERSION)!;
  const hit = VOICE_VERSIONS.find(v => v.id === version);
  return (!hit || hit.standby) ? fallback.agentName : hit.agentName;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: number; // epoch ms
}

export interface ConversationDoc {
  userId: string;
  characterId: string;
  messages: ChatMessage[];
  summary?: string;
  messageCount: number;
  updatedAt: FirebaseFirestore.Timestamp | Date;
  // 進行中的方法論（跨 turn 狀態機；null/缺省 = 沒有進行中）。
  // 進入/推進/退出全由程式依 [[METHOD_*]] 標記確定性更新，LLM 只發信號。
  activeMethodology?: ActiveMethodologyState | null;
}

export interface ActiveMethodologyState {
  id: string;         // methodologies doc id
  name: string;
  step: number;       // 1-based 當前步驟
  enteredAt: number;  // epoch ms
}

export type MemoryTier = 'fresh' | 'core' | 'archive';
export type MemoryType = 'fact' | 'emotion' | 'preference' | 'promise' | 'question' | 'milestone';
export type MemoryStatus = 'active' | 'stale' | 'resolved';

export interface MemoryDoc {
  userId: string;
  characterId: string;
  content: string;
  embedding?: number[];
  importance: number;       // 1-10
  tier: MemoryTier;
  type: MemoryType;         // fact / emotion / preference / promise / question / milestone
  status?: MemoryStatus;    // active（預設）/ stale / resolved
  emotionTag?: string;      // 說這件事時的情緒，僅 type=emotion 時有值
  hitCount: number;
  lastHitAt?: FirebaseFirestore.Timestamp | Date | null;
  lastAccessedAt?: FirebaseFirestore.Timestamp | Date | null;  // 最後帶進 prompt 的時間
  source: string;           // 'conversation' | 'voice' | 'extraction' | 'tool:remember'
  consolidatedAt?: FirebaseFirestore.Timestamp | Date | null;  // 夜間鞏固處理過的時間（含 skip）
  consolidatedInto?: string | null;  // 被吸收進哪條 impression（有值 → 不再直接進 prompt）
  rawContent?: string;      // 模糊化前的原文（第三期 gist 化；有值 = content 已是大意，原文永不硬刪）
  gistedAt?: FirebaseFirestore.Timestamp | Date | null;  // 模糊化時間
  createdAt: FirebaseFirestore.Timestamp | Date;
}

/**
 * 印象層 —— 記憶全景圖第二期（2026-07-07）。
 * 情節（memories）是「發生過什麼」，印象是「我對他的理解」——信念制。
 * 夜間鞏固管線把 fact/preference 情節消化成印象：支持（reinforce）/ 新增 / 矛盾推翻（supersededBy）。
 * confidence 不落庫，讀取時由 supportingEpisodes 數量＋新鮮度確定性計算。
 * 永不硬刪：被推翻的印象 status=superseded + supersededBy 可溯。
 */
export type ImpressionKind = 'fact' | 'preference';
export type ImpressionStatus = 'active' | 'superseded';

export interface ImpressionDoc {
  userId: string;
  characterId: string;
  content: string;              // 信念句（「用戶在科技業工作」）
  kind: ImpressionKind;
  embedding?: number[];         // 檢索相關性用
  supportingEpisodes: string[]; // memories doc ids（出處鏈）
  explicitSupport?: number;     // 顯式來源（tool:remember/voice 主動記住）的支持數——confidence 加成
  status: ImpressionStatus;
  supersededBy?: string | null;
  lastReinforcedAt: FirebaseFirestore.Timestamp | Date;
  createdAt: FirebaseFirestore.Timestamp | Date;
}

/**
 * 角色日記 —— 角色的獨立空間（用戶永遠看不到）。
 * 對話結束後角色寫給自己：今天的感受、沒說出口的觀察、下次想跟進的。
 * 讀路徑：dialogue system prompt 注入最近幾篇 → 角色會有「上次我就想問你」。
 */
export interface DiaryDoc {
  userId: string;
  characterId: string;
  entry: string;            // 角色第一人稱日記（80-200字）
  unspoken: string[];       // 沒說出口的觀察（0-3 條）
  nextTime: string[];       // 下次想問/想跟進的（0-2 條）
  mood: string;             // 角色此刻心情，一兩個詞
  source: string;           // 'text' | 'voice' | 'digest'（沉澱篇）
  status?: 'active' | 'archived';  // archived=已被沉澱吸收（digestedInto 可溯，不硬刪）
  digestedInto?: string;    // 被哪篇沉澱吸收
  createdAt: FirebaseFirestore.Timestamp | Date;
}

export interface RelationshipDoc {
  userId: string;
  characterId: string;
  conversationCount: number;
  firstConversationAt: FirebaseFirestore.Timestamp | Date;
  lastConversationAt: FirebaseFirestore.Timestamp | Date;
  consolidationWatermark?: FirebaseFirestore.Timestamp | Date | null;  // 鞏固管線處理到哪（episodes createdAt <= watermark 已消化）
}

export type DocumentStatus = 'pending' | 'writing' | 'rendering' | 'done' | 'failed';

export interface DocumentDoc {
  userId: string;
  characterId: string;
  title: string;
  mdContent?: string;
  htmlUrl?: string;
  slidesUrl?: string;
  status: DocumentStatus;
  error?: string;
  createdAt: FirebaseFirestore.Timestamp | Date;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface JobDoc {
  userId: string;
  characterId: string;
  type: 'document';
  brief: string;
  documentId: string;
  status: JobStatus;
  result?: string;
  error?: string;
  createdAt: FirebaseFirestore.Timestamp | Date;
}

/**
 * 知識庫（著作層）—— 角色「寫過/講過什麼」的單一真相源（2026-07-08）。
 *
 * 與 memories（用戶記憶層）分軸：知識綁 characterId（全用戶共享），記憶綁 (userId, characterId)。
 * 反亂編三件套：每塊帶 authority（權威度）＋ sectionRef（出處）＋ 檢索門檻 τ（撈不到寧可空手）。
 * 憲法層（soul）只管「他是誰」；著作層管「他寫過什麼」——跨層衝突時著作層在事實領域勝出。
 */
export type KnowledgeDocType = 'book' | 'article' | 'talk' | 'interview' | 'note';
export type KnowledgeAuthority = 'canonical' | 'paraphrase' | 'derived';  // 本人原話 / 轉述 / 整理

export interface KnowledgeDocDoc {
  characterId: string;
  title: string;               // 書名 / 文章名
  docType: KnowledgeDocType;
  authority: KnowledgeAuthority;
  sourceRef?: string;          // 可回溯的原始位置（版次/URL/出處說明）
  chunkCount: number;
  status: 'active' | 'archived';
  createdAt: FirebaseFirestore.Timestamp | Date;
}

/**
 * 知識提案 —— 共創閘（admin×methodProposalEnabled）下角色提的入庫候選。
 * 只是候選文字，不切塊不嵌入；審核通過（轉入庫）才走 ingestKnowledgeDoc 正式管線。
 * 為什麼要審：知識庫是事實層，角色會幻覺（Bacha Coffee 曾被記成 1876 咖啡）——
 * 權威度與真偽是 Adam 的編輯責任，不給角色自我入庫的直通管。
 */
export interface KnowledgeProposalDoc {
  characterId: string;
  title: string;
  content: string;          // 提案原文（審核通過才切塊）
  sourceNote?: string;      // 角色自述的內容來源（哪場對話/誰教的）
  proposedBy: string;       // 收下提案的 admin userId
  status: 'draft' | 'ingested' | 'rejected';
  ingestedDocId?: string;   // 轉入庫後 -> knowledge_docs id
  createdAt: FirebaseFirestore.Timestamp | Date;
}

export interface KnowledgeChunkDoc {
  characterId: string;         // 冗餘存一份，檢索免 join
  documentId: string;          // -> knowledge_docs
  content: string;             // 原文（呈現用，永不改寫）
  gist?: string;               // 白話大意（檢索索引用；文言/古典語料靠它跟白話 query 同語域）
  embedding?: number[];        // 768 維；有 gist 嵌 gist，沒有嵌原文（白話索引、原文呈現）
  sectionRef: string;          // 章節/段落定位（回答帶出處用），例「第3段」或編輯手填
  authority: KnowledgeAuthority; // 繼承自母表，仲裁用
  order: number;               // 在母文件中的順序（0-based）
  createdAt: FirebaseFirestore.Timestamp | Date;
}

/**
 * 方法論（教練框架層）—— 一套完整招式：被選中 → 照步驟走完，絕不切塊做語義檢索。
 * 只對 triggerDesc 做 embedding（選招用）；steps 是有序程序，進入後由
 * conversation.activeMethodology 狀態機推進（見 ActiveMethodologyState）。
 */
export interface MethodologyStep {
  order: number;          // 1-based
  instruction: string;    // 這一步角色該做什麼（引導語方向，不是逐字稿）
  exitCondition?: string; // 什麼情況算完成這一步、可以往下走
}

export interface MethodologyDoc {
  characterId: string;
  name: string;
  purpose: string;          // 這套方法解決什麼問題
  triggerDesc: string;      // 給選招判斷用的觸發描述（「用戶卡在……時」）
  triggerEmb?: number[];    // 只嵌觸發描述
  preconditions: string[];  // 使用前提（例：用戶需先陳述目標）
  steps: MethodologyStep[];
  // draft = 角色在 admin 對話中提案、待審核（對用戶完全隱形，不計入 methodologyCount）；
  // 審核轉正 → active 並 increment 計數。
  status: 'active' | 'archived' | 'draft';
  proposedBy?: string;      // 提案出身：收下提案的 admin userId（僅 draft 提案有值）
  createdAt: FirebaseFirestore.Timestamp | Date;
}

export interface BrandLayoutDoc {
  characterId: string;
  name: string;
  imageUrl: string;
  description: string;
  isDefault: boolean;
  createdAt: FirebaseFirestore.Timestamp | Date;
}

export interface BrandProductDoc {
  characterId: string;
  name: string;
  imageUrl: string;
  tags: string[];
  createdAt: FirebaseFirestore.Timestamp | Date;
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'draft' | 'submitted' | 'scripting' | 'ready' | 'scripted';

export interface TaskDoc {
  userId: string;
  characterId: string;
  type: TaskCapability;
  intent: string;          // 角色說的自然語言意圖
  params: Record<string, unknown>;
  status: TaskStatus;
  summary?: string;        // 完成後給角色讀的一句話摘要
  imageUrl?: string;       // image_generation 完成後的 GCS 圖片網址（圖庫直接讀這個）
  audioUrl?: string;       // audio_generation 完成後的 GCS 音檔網址
  videoUrl?: string;        // video_generation 完成後的 HeyGen 影片網址
  videoTaskId?: string;     // audio_generation task 對應的 HeyGen video_generation task id
  klingVideoTaskId?: string; // audio_generation task 對應的 Kling video_generation task id
  source?: string;           // video_generation 來源：'heygen' | 'kling'
  scriptText?: string;     // script_draft 的腳本原文（可編修）
  voiceId?: string;        // script_draft 綁定的角色 voiceId，生成音檔時帶入
  storyText?: string;      // story_draft 的故事原文（可編修）
  parentTaskId?: string;   // image_generation 所屬的 story_draft task id
  order?: number;          // 故事板中的圖片順序（1-based）
  cardText?: string;       // Phase B 產出：這張圖卡的文字說明
  cardType?: string;       // Phase B 產出：realistic_photo | infographic
  brandLayoutId?: string;  // story_draft 層：套用的品牌 Layout id
  productImageUrl?: string; // image_generation 層：這張卡片的產品圖 URL
  resultRef?: string;      // 指向真正結果的路徑，例如 "mw_jobs/xxx"
  // podcast_generation 專屬
  podcastCharacterIds?: string[];
  podcastTopic?: string;
  podcastWordCount?: number;
  podcastFocus?: string;
  podcastScript?: PodcastLine[];
  podcastPhase?: string;   // 'script_done' | 'audio_done'
  error?: string;
  notified: boolean;       // 是否已被注入 lastSession 通知過
  createdAt: FirebaseFirestore.Timestamp | Date;
  completedAt?: FirebaseFirestore.Timestamp | Date;
}
