import { NextResponse } from 'next/server';
import { getFirestore } from '@/lib/firebase-admin';
import { getCurrentUser } from '@/lib/session';
import { COL } from '@/lib/collections';
import { dispatchDocumentJob } from '@/lib/documents';

export const runtime = 'nodejs';

// POST /api/admin/jobs/retry — re-dispatch all pending document jobs
export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const db = getFirestore();
  const snap = await db.collection(COL.jobs)
    .where('type', '==', 'document')
    .where('status', '==', 'pending')
    .get();

  const jobIds = snap.docs.map(d => d.id);
  for (const jobId of jobIds) dispatchDocumentJob(jobId);

  return NextResponse.json({ dispatched: jobIds.length, jobIds });
}
