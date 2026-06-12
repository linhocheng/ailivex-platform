/**
 * Firebase Admin SDK 初始化（Server Side，用於 API Routes 讀寫 Firestore）
 */
import admin from 'firebase-admin';

let initialized = false;

export function getFirebaseAdmin() {
  if (initialized) return admin;

  if (!admin.apps.length) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || undefined;

    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id,
        storageBucket,
      });
    } else {
      admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket,
      });
    }
  }

  initialized = true;
  return admin;
}

export function getFirestore() {
  return getFirebaseAdmin().firestore();
}
