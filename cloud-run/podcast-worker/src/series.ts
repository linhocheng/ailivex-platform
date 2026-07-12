/**
 * 節目記憶（series memory）— 單集工具 → 節目的分水嶺
 *
 * 同一對角色錄過的集數，其交付物（共識/保留分歧/立場位移）餵回下一集的
 * 立場生成：已談攏的不重講、位移過的不退回、從沒談攏的地方接著挖。
 * 沒有這個，第二集的兩個人會失憶——老聽眾看得出來。
 *
 * 查詢只用等值條件（type + podcastCharacterIds 兩種順序），不需要 composite
 * index；狀態過濾與排序在程式裡做（一對角色的集數量級很小）。
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { DuoChar, EpisodeMeta } from './duo-types.js';

export interface SeriesContext {
  episodeCount: number;          // 之前一共錄過幾集
  sharedBlock: string;           // 給雙方看的共同節目記憶（最近兩集）
  perChar: Map<string, string>;  // characterId → 他自己的位移史（不退回的錨）
}

interface PrevEpisode {
  goal: string;
  meta: EpisodeMeta;
  at: number;
}

export async function loadSeriesContext(
  db: Firestore,
  a: DuoChar,
  b: DuoChar,
  excludeTaskId: string | undefined,
): Promise<SeriesContext | null> {
  let snaps;
  try {
    snaps = await Promise.all([[a.id, b.id], [b.id, a.id]].map(pair =>
      db.collection('tasks')
        .where('type', '==', 'podcast_generation')
        .where('podcastCharacterIds', '==', pair)
        .get(),
    ));
  } catch (err) {
    console.warn(`[duo] series 查詢失敗（不擋錄音）: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  const prev: PrevEpisode[] = snaps.flatMap(s => s.docs)
    .filter(d => d.id !== excludeTaskId)
    .map(d => d.data() as {
      status?: string; podcastEpisodeGoal?: string;
      podcastEpisodeMeta?: EpisodeMeta; createdAt?: Timestamp;
      userId?: string;
    })
    .filter(x => (x.status === 'scripted' || x.status === 'done')
      && x.podcastEpisodeMeta?.consensus?.length
      // 測試集不進節目正史（本機驗收時以 SERIES_INCLUDE_TEST=1 放行）
      && (process.env.SERIES_INCLUDE_TEST === '1' || x.userId !== 'zhu_duo_acceptance'))
    .map(x => ({
      goal: x.podcastEpisodeGoal ?? x.podcastEpisodeMeta!.episodeGoal,
      meta: x.podcastEpisodeMeta!,
      at: x.createdAt?.toMillis?.() ?? 0,
    }))
    .sort((x, y) => y.at - x.at);

  if (prev.length === 0) return null;

  const recent = prev.slice(0, 2); // 最近兩集進 prompt，再多會稀釋
  const label = (i: number) => (i === 0 ? '上一集' : '更早一集');

  const sharedBlock = recent.map((e, i) => {
    const lines = [
      `${label(i)}「${e.goal}」：`,
      `  你們談攏了：${e.meta.consensus.join('；')}`,
      `  沒談攏、誠實保留的：${e.meta.preservedDisagreement}`,
    ];
    return lines.join('\n');
  }).join('\n');

  const perChar = new Map<string, string>();
  for (const c of [a, b]) {
    const deltas = recent.flatMap(e => e.meta.beliefDeltas.filter(d => d.characterId === c.id).map(d => d.delta));
    if (deltas.length) {
      perChar.set(c.id,
        `你在之前的集數裡真的被說服過、移動過：\n${deltas.map(d => `- ${d}`).join('\n')}\n那些移動是真的——這一集不要退回移動前的位置。從移動之後的你出發。`);
    }
  }

  return { episodeCount: prev.length, sharedBlock, perChar };
}
