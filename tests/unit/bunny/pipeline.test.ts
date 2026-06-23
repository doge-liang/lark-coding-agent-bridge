import { describe, expect, it } from 'vitest';
import { scoreCandidate } from '../../../src/bunny/scoring';
import { TemplateBunnyGenerator } from '../../../src/bunny/generator';
import { checkDraftQuality } from '../../../src/bunny/quality';
import { planSchedule } from '../../../src/bunny/scheduler';

describe('Bunny content pipeline', () => {
  it('scores workflow tutorials above generic announcements', () => {
    const scored = scoreCandidate(
      {
        id: 'cand-1',
        sourceId: 'manual',
        title: 'Build a browser agent workflow for research',
        url: 'https://example.test/workflow',
        summary: 'Step-by-step automation workflow for AI research.',
        discoveredAt: '2026-06-23T00:00:00.000Z',
      },
      new Set(),
    );

    expect(scored.score).toBeGreaterThanOrEqual(80);
    expect(scored.reason).toContain('workflow');
  });

  it('generates bilingual notes and English-first post text', async () => {
    const generator = new TemplateBunnyGenerator();
    const draft = await generator.generate(
      {
        id: 'topic-1',
        candidateId: 'cand-1',
        title: 'Build a browser agent workflow for research',
        url: 'https://example.test/workflow',
        summary: 'Step-by-step automation workflow for AI research.',
        score: 91,
        reason: 'workflow tutorial',
        createdAt: '2026-06-23T00:00:00.000Z',
      },
      '2026-06-23T00:01:00.000Z',
    );

    expect(draft.chineseNote).toContain('中文理解');
    expect(draft.englishText).toContain('AI workflow');
    expect(draft.sourceUrl).toBe('https://example.test/workflow');
  });

  it('rejects unsupported earnings claims and accepts sourced workflow drafts', () => {
    expect(
      checkDraftQuality(
        {
          id: 'draft-1',
          topicId: 'topic-1',
          kind: 'single',
          chineseNote: '中文理解版',
          englishText: 'This tool guarantees $10k/month with no work.',
          sourceUrl: 'https://example.test/workflow',
          status: 'draft',
          createdAt: '2026-06-23T00:01:00.000Z',
        },
        new Set(),
      ),
    ).toEqual({ ok: false, reason: 'unsupported earnings claim' });

    const qualityResult = checkDraftQuality(
      {
        id: 'draft-2',
        topicId: 'topic-1',
        kind: 'single',
        chineseNote: '中文理解版',
        englishText: 'A practical AI workflow for faster research: source, summarize, verify, publish.',
        sourceUrl: 'https://example.test/workflow',
        status: 'draft',
        createdAt: '2026-06-23T00:01:00.000Z',
      },
      new Set(),
    );

    expect(qualityResult).toMatchObject({ ok: true });
    expect(typeof qualityResult).toBe('object');
    if ('contentHash' in qualityResult) {
      expect(typeof qualityResult.contentHash).toBe('string');
    }
  });

  it('schedules within conservative V1 cadence', () => {
    const schedule = planSchedule({
      draftIds: ['draft-1', 'draft-2', 'draft-3'],
      nowIso: '2026-06-23T08:00:00.000Z',
      dailyLimit: 2,
    });

    expect(schedule).toEqual([
      { draftId: 'draft-1', publishAt: '2026-06-23T12:00:00.000Z' },
      { draftId: 'draft-2', publishAt: '2026-06-23T18:00:00.000Z' },
    ]);
  });

  it('uses UTC-local date when scheduling from offset timestamps', () => {
    const schedule = planSchedule({
      draftIds: ['draft-1', 'draft-2'],
      nowIso: '2026-06-23T23:30:00-02:00',
      dailyLimit: 2,
    });

    expect(schedule[0]).toEqual({ draftId: 'draft-1', publishAt: '2026-06-24T12:00:00.000Z' });
  });
});
