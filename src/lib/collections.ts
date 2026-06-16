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
} as const;

export type UserRole = 'user' | 'admin';

export interface UserDoc {
  username: string;
  passwordHash: string;   // scrypt: salt:hash (hex)
  displayName: string;
  role: UserRole;
  createdAt: FirebaseFirestore.Timestamp | Date;
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

export interface CharacterDoc {
  name: string;
  soul: string;            // 原始靈魂文字
  soulCore: string;        // soul-enhance 後的精煉版
  avatarUrl: string;
  voiceIdMinimax?: string; // 即時語音用
  voiceSettings?: VoiceSettings;
  convSettings?: ConvSettings;  // 對話手感旋鈕
  aliases?: string[];      // 角色別名，多人房 deterministic target resolver 用
  status: CharacterStatus;
  createdAt: FirebaseFirestore.Timestamp | Date;
}

export interface AccessDoc {
  userId: string;
  characterId: string;
  grantedAt: FirebaseFirestore.Timestamp | Date;
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
