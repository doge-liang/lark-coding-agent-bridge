import { describe, expect, it } from 'vitest';
import { buildDailyReport, formatBunnyDailyReport } from '../../../src/bunny/reporter';
import type { BunnyStatus, BunnyToday } from '../../../src/bunny/types';

describe('Bunny reporter', () => {
  it('formats an empty daily report for Lark', () => {
    expect(
      formatBunnyDailyReport({
        date: '2026-06-24',
        timezone: 'UTC',
        scheduled: [],
        published: [],
        skipped: [],
        sources: [],
        warnings: [],
        nextTopics: [],
      }),
    ).toBe(
      [
        '**Bunny Daily Report - 2026-06-24**',
        'Timezone: UTC',
        '',
        '**Summary**',
        '- Scheduled: 0',
        '- Published: 0',
        '- Skipped: 0',
        '',
        '**Scheduled**',
        'None.',
        '',
        '**Published**',
        'None.',
        '',
        '**Skipped**',
        'None.',
        '',
        '**Sources**',
        'None.',
        '',
        '**Warnings**',
        'None.',
        '',
        '**Next Topics**',
        'None.',
      ].join('\n'),
    );
  });

  it('formats populated scheduled, published, skipped, source, warning, and next-topic sections', () => {
    const report = formatBunnyDailyReport({
      date: '2026-06-24',
      timezone: 'America/Los_Angeles',
      scheduled: [
        {
          title: 'Agent runtime menu',
          publishAt: '2026-06-24T17:00:00.000Z',
          status: 'scheduled',
          sourceUrl: 'https://example.test/source-1',
        },
      ],
      published: [
        {
          title: 'Hook runner shipped',
          publishAt: '2026-06-24T13:00:00.000Z',
          status: 'published',
          postUrl: 'https://x.com/i/web/status/123',
        },
      ],
      skipped: [
        {
          title: 'Duplicate topic',
          reason: 'already covered this week',
          sourceUrl: 'https://example.test/source-2',
        },
      ],
      sources: [
        { title: 'Runtime design', url: 'https://example.test/design' },
        { title: 'No link source' },
      ],
      warnings: ['Dry-run mode is still enabled'],
      nextTopics: ['Review quality gates', 'Schedule cadence'],
    });

    expect(report).toContain('**Bunny Daily Report - 2026-06-24**');
    expect(report).toContain('Timezone: America/Los_Angeles');
    expect(report).toContain('- Scheduled: 1');
    expect(report).toContain(
      '- Agent runtime menu - 2026-06-24T17:00:00.000Z - scheduled - https://example.test/source-1',
    );
    expect(report).toContain(
      '- Hook runner shipped - 2026-06-24T13:00:00.000Z - published - https://x.com/i/web/status/123',
    );
    expect(report).toContain(
      '- Duplicate topic - skipped: already covered this week - https://example.test/source-2',
    );
    expect(report).toContain('- [Runtime design](https://example.test/design)');
    expect(report).toContain('- No link source');
    expect(report).toContain('- Dry-run mode is still enabled');
    expect(report).toContain('- Review quality gates');
    expect(report).toContain('- Schedule cadence');
  });

  it('builds a daily report from Bunny engine status and today snapshots', () => {
    const status: BunnyStatus = {
      paused: false,
      livePublishing: false,
      queuedPosts: 1,
      dailyCreditBudget: 50,
    };
    const today: BunnyToday = {
      scheduled: [
        {
          id: 'sched-1',
          draftId: 'draft-1',
          postKey: 'post-key-1',
          publishAt: '2026-06-24T12:00:00.000Z',
          status: 'published',
          xPostId: '123',
          xPostUrl: 'https://x.com/i/web/status/123',
        },
        {
          id: 'sched-2',
          draftId: 'draft-2',
          postKey: 'post-key-2',
          publishAt: '2026-06-24T18:00:00.000Z',
          status: 'skipped',
          errorMessage: 'quality gate failed',
        },
      ],
      drafts: [
        {
          id: 'draft-1',
          topicId: 'topic-1',
          kind: 'single',
          chineseNote: '中文理解: Browser agent workflow',
          englishText: 'AI workflow worth studying: Browser agent workflow',
          sourceUrl: 'https://example.test/browser-agent',
          status: 'draft',
          createdAt: '2026-06-24T10:00:00.000Z',
        },
      ],
    };

    const report = buildDailyReport(today, status, new Map([
      ['post-key-1', [{ impressions: 100, likes: 8, reposts: 2, replies: 1 }]],
    ]));

    expect(report).toContain('Bunny Daily Report');
    expect(report).toContain('Mode: dry-run');
    expect(report).toContain('100 impressions');
    expect(report).toContain('Browser agent workflow');
    expect(report).toContain('quality gate failed');
  });
});
