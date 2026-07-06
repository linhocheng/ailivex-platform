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
  documents: 'documents',
  jobs: 'jobs',
  tasks: 'tasks',
  brandLayouts: 'brand_layouts',
  brandProducts: 'brand_products',
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

export interface PodcastLine {
  speaker: string;
  characterId: string;
  text: string;
}

export interface CharacterDoc {
  name: string;
  soul: string;            // 原始靈魂文字
  soulCore: string;        // soul-enhance 後的精煉版
  avatarUrl: string;
  voiceIdMinimax?: string; // 即時語音用
  voiceSettings?: VoiceSettings;
  convSettings?: ConvSettings;  // 對話手感旋鈕
  aliases?: string[];      // 角色別名，多人房 deterministic target resolver 用
  capabilities?: TaskCapability[];  // 允許呼叫的工廠能力，缺省 = 空陣列
  imageStyle?: string;     // 圖片生成風格描述（story_draft 生圖 prompt prefix）
  heygenAvatarId?: string;    // HeyGen talking_photo_id（avatar_iv 引擎）
  heygenAvatarIdV3?: string;  // HeyGen talking_photo_id（avatar_iii 引擎，需分開訓練）
  heygenAvatarUrl?: string;  // HeyGen 上傳後的預覽 URL（v3 image 欄位用）
  status: CharacterStatus;
  createdAt: FirebaseFirestore.Timestamp | Date;
}

export interface AccessDoc {
  userId: string;
  characterId: string;
  voiceVersion?: string;   // 指派的語音 agent 版本（VOICE_VERSIONS.id）；缺省 = 全域預設
  grantedAt: FirebaseFirestore.Timestamp | Date;
}

/**
 * 語音 agent 版本登錄表 —— 單一真相源（封存備查）。
 * 前台只顯示 DEFAULT_VOICE_VERSION（v14）；舊版本封存於此作為迭代紀錄。
 * token route 只走 DEFAULT_VOICE_VERSION，不再逐版切換。
 *
 * 版本迭代歷史：
 *   base  基礎 1:1 語音對話
 *   v2    記憶連貫（lastSession 快照、時間感知）
 *   v3    主動發話（3a 一吋蛋糕實驗）
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
 *   v16   ★ LIVE — 語音延遲優化（VAD prewarm + min_silence 0.3 + TTS 首段 flush）（回滾=DEFAULT 切回 v15，v15 服務保持熱備）
 */
export const VOICE_VERSIONS = [
  { id: 'base', label: '基礎', agentName: 'ailivex-realtime' },
  { id: 'v2',  label: '2.0',  agentName: 'ailivex-realtime-v2' },
  { id: 'v3',  label: '3.0',  agentName: 'ailivex-realtime-v3' },
  { id: 'v4',  label: '4.0',  agentName: 'ailivex-realtime-v4' },
  { id: 'v5',  label: '5.0',  agentName: 'ailivex-realtime-v5' },
  { id: 'v6',  label: '6.0',  agentName: 'ailivex-realtime-v6' },
  { id: 'v8',  label: '8.0',  agentName: 'ailivex-realtime-v8' },
  { id: 'v9',  label: '9.0',  agentName: 'ailivex-realtime-v9' },
  { id: 'v10', label: '10',   agentName: 'ailivex-realtime-v10' },
  { id: 'v11', label: '11',   agentName: 'ailivex-realtime-v11' },
  { id: 'v12', label: '12',   agentName: 'ailivex-realtime-v12' },
  { id: 'v13', label: '13',   agentName: 'ailivex-realtime-v13' },
  { id: 'v14', label: '14',   agentName: 'ailivex-realtime-v14' },
  { id: 'v15', label: '15',   agentName: 'ailivex-realtime-v15' }, // 記憶對等 + 通話中動態想起
  { id: 'v16', label: '16',   agentName: 'ailivex-realtime-v16' }, // LIVE — 語音延遲優化（prewarm/VAD 0.3/首段 flush）
] as const;

export const DEFAULT_VOICE_VERSION = 'v16';

/** 版本 id → LiveKit agentName。未知/缺省 → 全域預設版本。 */
export function agentNameForVersion(version?: string): string {
  const fallback = VOICE_VERSIONS.find(v => v.id === DEFAULT_VOICE_VERSION)!;
  return (VOICE_VERSIONS.find(v => v.id === version) || fallback).agentName;
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
  createdAt: FirebaseFirestore.Timestamp | Date;
}

export interface RelationshipDoc {
  userId: string;
  characterId: string;
  conversationCount: number;
  firstConversationAt: FirebaseFirestore.Timestamp | Date;
  lastConversationAt: FirebaseFirestore.Timestamp | Date;
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
