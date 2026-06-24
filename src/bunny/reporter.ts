import type { BunnyStatus, BunnyToday } from './types';

export interface BunnyMetricSummary {
  impressions: number;
  likes: number;
  reposts: number;
  replies: number;
}

export interface BunnyDailyReportInput {
  date: string;
  timezone: string;
  scheduled: Array<{
    title: string;
    publishAt: string;
    status: string;
    sourceUrl?: string;
  }>;
  published: Array<{
    title: string;
    publishAt: string;
    status: string;
    postUrl?: string;
  }>;
  skipped: Array<{
    title: string;
    reason: string;
    sourceUrl?: string;
  }>;
  sources: Array<{
    title: string;
    url?: string;
  }>;
  warnings: string[];
  nextTopics: string[];
}

export function formatBunnyDailyReport(input: BunnyDailyReportInput): string {
  return [
    `**Bunny Daily Report - ${input.date}**`,
    `Timezone: ${input.timezone}`,
    '',
    '**Summary**',
    `- Scheduled: ${input.scheduled.length}`,
    `- Published: ${input.published.length}`,
    `- Skipped: ${input.skipped.length}`,
    '',
    '**Scheduled**',
    ...sectionOrNone(input.scheduled.map((item) =>
      [
        `- ${item.title}`,
        item.publishAt,
        item.status,
        item.sourceUrl,
      ].filter(Boolean).join(' - '),
    )),
    '',
    '**Published**',
    ...sectionOrNone(input.published.map((item) =>
      [
        `- ${item.title}`,
        item.publishAt,
        item.status,
        item.postUrl,
      ].filter(Boolean).join(' - '),
    )),
    '',
    '**Skipped**',
    ...sectionOrNone(input.skipped.map((item) =>
      [
        `- ${item.title}`,
        `skipped: ${item.reason}`,
        item.sourceUrl,
      ].filter(Boolean).join(' - '),
    )),
    '',
    '**Sources**',
    ...sectionOrNone(input.sources.map((source) =>
      source.url ? `- [${source.title}](${source.url})` : `- ${source.title}`,
    )),
    '',
    '**Warnings**',
    ...sectionOrNone(input.warnings.map((warning) => `- ${warning}`)),
    '',
    '**Next Topics**',
    ...sectionOrNone(input.nextTopics.map((topic) => `- ${topic}`)),
  ].join('\n');
}

export function buildDailyReport(
  today: BunnyToday,
  status: BunnyStatus,
  metricsByPostKey: Map<string, BunnyMetricSummary[]>,
): string {
  const mode = status.livePublishing ? 'live' : 'dry-run';
  const scheduled = today.scheduled.length
    ? today.scheduled.map((post) => {
        const metric = metricsByPostKey.get(post.postKey)?.[0];
        const metricText = metric
          ? ` - ${metric.impressions} impressions, ${metric.likes} likes, ${metric.reposts} reposts, ${metric.replies} replies`
          : '';
        const postUrl = post.xPostUrl ? ` ${post.xPostUrl}` : '';
        const error = post.errorMessage ? ` - ${post.errorMessage}` : '';
        return `- ${post.publishAt} ${post.status} \`${post.postKey}\`${postUrl}${metricText}${error}`;
      })
    : ['- No scheduled posts for today'];
  const drafts = today.drafts.length
    ? today.drafts.slice(0, 5).map((draft) => {
        const quality = draft.qualityFailure ? ` - ${draft.qualityFailure}` : '';
        return `- ${firstLine(draft.englishText)} (${draft.sourceUrl})${quality}`;
      })
    : ['- No drafts generated yet'];
  const warnings = [
    status.paused ? '- Publishing is paused' : undefined,
    status.lastError ? `- Last error: ${status.lastError}` : undefined,
  ].filter(Boolean) as string[];

  return [
    '**Bunny Daily Report**',
    `Mode: ${mode}`,
    `State: ${status.paused ? 'paused' : 'running'}`,
    `Queue: ${status.queuedPosts}`,
    `Daily budget: ${status.dailyCreditBudget} credits`,
    ...(status.lastPublishedAt ? [`Last published: ${status.lastPublishedAt}`] : []),
    '',
    '**Scheduled**',
    ...scheduled,
    '',
    '**Latest Drafts**',
    ...drafts,
    ...(warnings.length ? ['', '**Warnings**', ...warnings] : []),
  ].join('\n');
}

function firstLine(value: string): string {
  return value.split('\n')[0]?.trim() || value.trim();
}

function sectionOrNone(lines: string[]): string[] {
  return lines.length ? lines : ['None.'];
}
