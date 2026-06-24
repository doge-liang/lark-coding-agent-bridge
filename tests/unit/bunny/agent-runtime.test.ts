import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BunnyAgentRuntime } from '../../../src/bunny/agent/runtime';
import { BunnyEngine } from '../../../src/bunny/engine';
import { BunnyStore } from '../../../src/bunny/store';
import { manualCandidate } from '../../../src/bunny/sources';

const roots: string[] = [];

describe('BunnyAgentRuntime', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('dispatches explicit research and review skills', async () => {
    const store = await createStore();
    store.upsertCandidate(manualCandidate({
      title: 'Browser agent workflow',
      url: 'https://example.test/browser-agent',
      summary: 'Step-by-step AI workflow for research automation.',
      nowIso: '2026-06-24T09:00:00.000Z',
    }));
    const runtime = new BunnyAgentRuntime({ engine: new BunnyEngine({ store }), store });

    const research = await runtime.dispatch({ skill: 'research_topics', nowIso: '2026-06-24T10:00:00.000Z' });
    expect(research.ok).toBe(true);
    expect(research.markdown).toContain('generated');

    const queue = await runtime.dispatch({ skill: 'review_queue', nowIso: '2026-06-24T10:00:00.000Z' });
    expect(queue.ok).toBe(true);
    expect(queue.markdown).toContain('Review Queue');
  });

  it('requires confirmation for scheduling and resume actions', async () => {
    const store = await createStore();
    const runtime = new BunnyAgentRuntime({ engine: new BunnyEngine({ store }), store });

    await expect(runtime.dispatch({ skill: 'schedule_posts' })).resolves.toMatchObject({
      ok: false,
      requiresConfirmation: true,
    });
    await expect(runtime.dispatch({ skill: 'resume_publishing' })).resolves.toMatchObject({
      ok: false,
      requiresConfirmation: true,
    });
  });

  it('pauses publishing through an explicit skill', async () => {
    const store = await createStore();
    const runtime = new BunnyAgentRuntime({ engine: new BunnyEngine({ store }), store });

    const result = await runtime.dispatch({ skill: 'pause_publishing' });

    expect(result.ok).toBe(true);
    expect(store.getSettings().paused).toBe(true);
    expect(result.markdown).toContain('paused');
  });
});

async function createStore(): Promise<BunnyStore> {
  const root = await mkdtemp(join(tmpdir(), 'bunny-agent-runtime-'));
  roots.push(root);
  return new BunnyStore(join(root, 'bunny.sqlite'));
}
