/**
 * cloudrun-billing — Cloud Run 計費錶真值（Cloud Monitoring billable_instance_time）
 *
 * 天條：驗「不燒錢了」看計費錶歸零，不是設定畫面。這個模組就是計費錶。
 * 設定面（minScale）、實例面（現役 revision）、計費面（本指標）是三件事——
 * 帳單曲線和「已清理」的認知對不上時，第一眼看這裡。
 *
 * ALIGN_RATE 對 billable_instance_time（累計計費秒）取變化率 → s/s ＝平均計費實例台數；
 * ×窗長（小時）＝實例時。alignmentPeriod 設成整個窗 → 每個 service 恰好一個點。
 */
import { cloudRunAccessToken, getProjectId } from '@/lib/voice-power';

export interface BillingRow {
  service: string;
  avgInstances: number;   // 窗內平均計費實例台數
  instanceHours: number;  // 窗內累計實例時
}

export async function readBillableInstanceTime(windowH: number, timeoutMs = 6000): Promise<BillingRow[] | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const token = await cloudRunAccessToken();
    const end = new Date();
    const start = new Date(end.getTime() - windowH * 3600_000);
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${getProjectId()}/timeSeries`);
    url.searchParams.set('filter', 'metric.type="run.googleapis.com/container/billable_instance_time" AND resource.type="cloud_run_revision"');
    url.searchParams.set('interval.startTime', start.toISOString());
    url.searchParams.set('interval.endTime', end.toISOString());
    url.searchParams.set('aggregation.alignmentPeriod', `${windowH * 3600}s`);
    url.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_RATE');
    url.searchParams.set('aggregation.crossSeriesReducer', 'REDUCE_SUM');
    url.searchParams.append('aggregation.groupByFields', 'resource.labels.service_name');

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json() as {
      timeSeries?: { resource?: { labels?: { service_name?: string } }; points?: { value?: { doubleValue?: number } }[] }[];
    };
    const rows: BillingRow[] = (body.timeSeries || []).map(ts => {
      const avg = Number(ts.points?.[0]?.value?.doubleValue || 0);
      return {
        service: ts.resource?.labels?.service_name || '?',
        avgInstances: Math.round(avg * 1000) / 1000,
        instanceHours: Math.round(avg * windowH * 10) / 10,
      };
    }).filter(r => r.instanceHours >= 0.1);
    rows.sort((a, b) => b.instanceHours - a.instanceHours);
    return rows;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
