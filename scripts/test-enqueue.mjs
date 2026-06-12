import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const env = readFileSync('.env.local', 'utf8');
const SA_JSON = env.match(/FIREBASE_SERVICE_ACCOUNT_JSON='([^']+)'/)?.[1];
const BRIDGE_URL = env.match(/BRIDGE_URL="([^"]+)"/)?.[1] || '';
const DOC_WORKER_URL = env.match(/DOC_WORKER_URL="([^"]+)"/)?.[1] || '';
const GCP_PROJECT_ID = env.match(/GCP_PROJECT_ID="([^"]+)"/)?.[1] || '';
const DOC_TASKS_QUEUE = env.match(/DOC_TASKS_QUEUE="([^"]+)"/)?.[1] || '';
const DOC_WORKER_INVOKER_SA = env.match(/DOC_WORKER_INVOKER_SA="([^"]+)"/)?.[1] || '';

const { GoogleAuth } = require('google-auth-library');

const auth = new GoogleAuth({
  credentials: JSON.parse(SA_JSON),
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const token = await auth.getAccessToken();
const accessToken = typeof token === 'string' ? token : token?.token || '';
console.log('Got access token:', accessToken.slice(0, 20) + '...');

const jobId = process.argv[2] || 'OUDtpVNYZdP5u5lXioea';
const location = 'us-central1';
const url = `https://cloudtasks.googleapis.com/v2/projects/${GCP_PROJECT_ID}/locations/${location}/queues/${DOC_TASKS_QUEUE}/tasks`;

const body = Buffer.from(JSON.stringify({ jobId })).toString('base64');
const task = {
  httpRequest: {
    httpMethod: 'POST',
    url: `${DOC_WORKER_URL.replace(/\/$/, '')}/process`,
    headers: { 'Content-Type': 'application/json' },
    body,
    oidcToken: { serviceAccountEmail: DOC_WORKER_INVOKER_SA, audience: DOC_WORKER_URL },
  },
};

console.log('Calling Cloud Tasks:', url);
console.log('Worker URL:', DOC_WORKER_URL);
console.log('OIDC SA:', DOC_WORKER_INVOKER_SA);

const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ task }),
});

const resBody = await res.text();
console.log('Status:', res.status);
console.log('Body:', resBody.slice(0, 500));
process.exit(0);
