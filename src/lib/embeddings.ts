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
  const auth = getAuth();
  const tokenResult = await auth.getAccessToken();
  const accessToken = typeof tokenResult === 'string' ? tokenResult : (tokenResult as unknown as { token?: string })?.token || '';
  const projectId = getProjectId();

  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      instances: [{ content: text }],
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
