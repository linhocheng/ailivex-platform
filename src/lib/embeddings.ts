/**
 * 語義向量工具（Vertex AI text-embedding-004）
 * 把文字變成向量，讓記憶可以用意思搜尋，不是碰關鍵字。
 */
import { GoogleAuth } from 'google-auth-library';

const EMBEDDING_MODEL = 'text-embedding-004';
const DIMENSION = 768;

let authClient: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (authClient) return authClient;

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (saJson) {
    const sa = JSON.parse(saJson);
    authClient = new GoogleAuth({
      credentials: sa,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  } else {
    authClient = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return authClient;
}

function getProjectId(): string {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (saJson) {
    return JSON.parse(saJson).project_id;
  }
  return process.env.FIREBASE_PROJECT_ID || '';
}

export async function generateEmbedding(text: string): Promise<number[]> {
  return embedWith(EMBEDDING_MODEL, text);
}

/**
 * 知識庫／方法論專用 embedding —— 與 memories（text-embedding-004）分模型。
 *
 * 為什麼分：004 對中文短句 cosine 坍縮（無關句對 0.90+，甚至無關>相關），
 * 絕對門檻 τ 無法運作；multilingual-002 + task_type 實測相關/無關拉開 0.79 vs 0.54。
 * memories 池已以 004 建庫且自洽，不動；knowledge_chunks / methodologies 從第一天就用這顆。
 * kind：入庫的塊/觸發描述用 'document'，用戶這句話用 'query'（不對稱嵌入，成對才準）。
 */
const KNOWLEDGE_EMBEDDING_MODEL = 'text-multilingual-embedding-002';

export async function generateKnowledgeEmbedding(
  text: string,
  kind: 'query' | 'document',
): Promise<number[]> {
  return embedWith(KNOWLEDGE_EMBEDDING_MODEL, text, kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT');
}

async function embedWith(model: string, text: string, taskType?: string): Promise<number[]> {
  const auth = getAuth();
  const tokenResult = await auth.getAccessToken();
  const accessToken = typeof tokenResult === 'string' ? tokenResult : (tokenResult as unknown as { token?: string })?.token || '';
  const projectId = getProjectId();

  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/${model}:predict`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      instances: [{ content: text, ...(taskType ? { task_type: taskType } : {}) }],
      parameters: { outputDimensionality: DIMENSION },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding 失敗 (${response.status}): ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  const values = data.predictions?.[0]?.embeddings?.values;

  if (!values || !Array.isArray(values)) {
    throw new Error('Embedding 回傳格式異常');
  }

  // 維度自檢：模型名 / outputDimensionality 漂移會靜默存錯維度向量 → findNearest 失準。
  if (values.length !== DIMENSION) {
    throw new Error(`Embedding 維度異常：期望 ${DIMENSION}，實得 ${values.length}（模型或參數可能漂移）`);
  }

  return values;
}

export const EMBEDDING_DIMENSION = DIMENSION;

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
