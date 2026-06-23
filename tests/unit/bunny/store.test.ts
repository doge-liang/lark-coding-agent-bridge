import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BunnyStore } from '../../../src/bunny/store';

const roots: string[] = [];

describe('BunnyStore', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('initializes settings and reports empty status', async () => {
    const store = await createStore();

    expect(store.getSettings()).toMatchObject({
      paused: false,
      livePublishing: false,
      dailyPostLimit: 2,
    });
    expect(store.status()).toMatchObject({
      paused: false,
      livePublishing: false,
      queuedPosts: 0,
      dailyCreditBudget: 50,
    });
  });

  it('upserts candidates, drafts, and scheduled posts without duplicates', async () => {
    const store = await createStore();

    store.upsertCandidate({
      id: 'cand-1',
      sourceId: 'manual',
      title: 'Agent browser automation',
      url: 'https://example.test/agent-browser',
      summary: 'A tool for browser-based AI workflows.',
      discoveredAt: '2026-06-23T00:00:00.000Z',
    });
    store.upsertCandidate({
      id: 'cand-1',
      sourceId: 'manual',
      title: 'Agent browser automation',
      url: 'https://example.test/agent-browser',
      summary: 'A tool for browser-based AI workflows.',
      discoveredAt: '2026-06-23T00:00:00.000Z',
    });

    expect(store.listCandidates()).toHaveLength(1);

    store.saveDraft({
      id: 'draft-1',
      topicId: 'topic-1',
      kind: 'single',
      chineseNote: '中文理解版',
      englishText: 'A useful AI workflow tool.',
      sourceUrl: 'https://example.test/agent-browser',
      status: 'draft',
      createdAt: '2026-06-23T00:01:00.000Z',
    });
    store.schedulePost({
      id: 'sched-1',
      draftId: 'draft-1',
      postKey: 'post-key-1',
      publishAt: '2026-06-23T12:00:00.000Z',
      status: 'scheduled',
    });

    expect(store.today('2026-06-23T00:00:00.000Z').scheduled).toHaveLength(1);
    expect(() =>
      store.schedulePost({
        id: 'sched-2',
        draftId: 'draft-1',
        postKey: 'post-key-1',
        publishAt: '2026-06-23T13:00:00.000Z',
        status: 'scheduled',
      }),
    ).not.toThrow();
    expect(store.today('2026-06-23T00:00:00.000Z').scheduled).toHaveLength(1);
  });

  it('persists topics and post metrics', async () => {
    const store = await createStore();
    store.saveTopic({
      id: 'topic-1',
      candidateId: 'cand-1',
      title: 'Browser agent workflow',
      url: 'https://example.test/browser-agent',
      summary: 'A workflow tutorial.',
      score: 91,
      reason: 'workflow,tutorial',
      createdAt: '2026-06-23T00:00:00.000Z',
    });
    store.recordMetric({
      postKey: 'post-key-1',
      impressions: 100,
      likes: 8,
      reposts: 2,
      replies: 1,
      capturedAt: '2026-06-23T13:00:00.000Z',
    });

    expect(store.listTopics()).toHaveLength(1);
    expect(store.listMetrics('post-key-1')).toEqual([
      {
        postKey: 'post-key-1',
        impressions: 100,
        likes: 8,
        reposts: 2,
        replies: 1,
        capturedAt: '2026-06-23T13:00:00.000Z',
      },
    ]);
  });

  it('pauses and resumes publishing state', async () => {
    const store = await createStore();

    store.setPaused(true);
    expect(store.status().paused).toBe(true);

    store.setPaused(false);
    expect(store.status().paused).toBe(false);
  });
});

async function createStore(): Promise<BunnyStore> {
  const root = await mkdtemp(join(tmpdir(), 'bunny-store-'));
  roots.push(root);
  return new BunnyStore(join(root, 'bunny.sqlite'));
}
