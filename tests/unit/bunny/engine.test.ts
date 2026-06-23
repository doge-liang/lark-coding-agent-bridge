import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BunnyEngine } from '../../../src/bunny/engine';
import { BunnyStore } from '../../../src/bunny/store';
import { manualCandidate } from '../../../src/bunny/sources';

const roots: string[] = [];

describe('BunnyEngine', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('runs one dry-run pipeline and schedules posts', async () => {
    const store = await createStore();
    store.upsertCandidate(manualCandidate({
      title: 'Browser agent workflow',
      url: 'https://example.test/browser-agent',
      summary: 'Step-by-step AI workflow for research automation.',
      nowIso: '2026-06-23T09:00:00.000Z',
    }));
    const engine = new BunnyEngine({ store });

    const result = await engine.runOnce('2026-06-23T10:00:00.000Z');

    expect(result.generatedDrafts).toBe(1);
    expect(result.scheduledPosts).toBe(1);
    expect(store.status().queuedPosts).toBe(1);
  });

  it('does not publish while paused', async () => {
    const store = await createStore();
    store.setPaused(true);
    const engine = new BunnyEngine({ store });

    await expect(engine.publishDue('2026-06-23T12:00:00.000Z')).resolves.toEqual({
      published: 0,
      skipped: 'paused',
    });
  });
});

async function createStore(): Promise<BunnyStore> {
  const root = await mkdtemp(join(tmpdir(), 'bunny-engine-'));
  roots.push(root);
  return new BunnyStore(join(root, 'bunny.sqlite'));
}
