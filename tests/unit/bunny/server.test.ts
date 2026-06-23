import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BunnyEngine } from '../../../src/bunny/engine';
import { startBunnyServer } from '../../../src/bunny/server';
import { BunnyStore } from '../../../src/bunny/store';

const roots: string[] = [];

describe('Bunny local server', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('serves status and pause/resume controls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bunny-server-'));
    roots.push(root);
    const store = new BunnyStore(join(root, 'bunny.sqlite'));
    const server = await startBunnyServer({
      engine: new BunnyEngine({ store }),
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      expect(await json(`${base}/status`)).toMatchObject({ paused: false });

      await fetch(`${base}/pause`, { method: 'POST' });
      expect(await json(`${base}/status`)).toMatchObject({ paused: true });

      await fetch(`${base}/resume`, { method: 'POST' });
      expect(await json(`${base}/status`)).toMatchObject({ paused: false });
    } finally {
      await server.close();
    }
  });
});

async function json(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json();
}
