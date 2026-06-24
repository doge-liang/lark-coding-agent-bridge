import { describe, expect, it } from 'vitest';
import {
  BUNNY_HOOK_NAMES,
  createBunnyHookRunner,
  type BunnyHookName,
} from '../../../src/bunny/agent/hooks';

describe('Bunny hook runner', () => {
  it('exposes explicit before and after hook names', () => {
    const names: BunnyHookName[] = [
      'before_research',
      'after_research',
      'before_draft',
      'after_draft',
      'before_schedule',
      'after_schedule',
      'before_publish',
      'after_publish',
      'before_report',
      'after_report',
    ];

    for (const name of names) {
      expect(BUNNY_HOOK_NAMES).toContain(name);
    }
  });

  it('runs registered hooks in deterministic order', async () => {
    const calls: string[] = [];
    const runner = createBunnyHookRunner([
      { name: 'after_research', run: async () => { calls.push('first'); } },
      { name: 'after_research', run: () => { calls.push('second'); return { ok: true, note: 'stored' }; } },
      { name: 'after_draft', run: async () => { calls.push('other'); } },
    ]);

    const result = await runner.run('after_research', { nowIso: '2026-06-24T00:00:00.000Z' });

    expect(calls).toEqual(['first', 'second']);
    expect(result).toEqual({
      hook: 'after_research',
      ok: true,
      results: [{ ok: true }, { ok: true, note: 'stored' }],
      failures: [],
    });
  });

  it('records failures and continues by default', async () => {
    const calls: string[] = [];
    const runner = createBunnyHookRunner([
      {
        name: 'before_publish',
        run: () => {
          calls.push('first');
          throw new Error('paused');
        },
      },
      { name: 'before_publish', run: () => { calls.push('second'); } },
    ]);

    const result = await runner.run('before_publish', { nowIso: '2026-06-24T00:00:00.000Z' });

    expect(calls).toEqual(['first', 'second']);
    expect(result.ok).toBe(false);
    expect(result.results).toEqual([{ ok: false, error: 'paused' }, { ok: true }]);
    expect(result.failures).toEqual([{ hook: 'before_publish', index: 0, error: 'paused' }]);
  });

  it('can stop on the first failure', async () => {
    const calls: string[] = [];
    const runner = createBunnyHookRunner([
      {
        name: 'before_schedule',
        run: () => {
          calls.push('first');
          throw new Error('approval required');
        },
      },
      { name: 'before_schedule', run: () => { calls.push('second'); } },
    ]);

    const result = await runner.run(
      'before_schedule',
      { nowIso: '2026-06-24T00:00:00.000Z' },
      { continueOnError: false },
    );

    expect(calls).toEqual(['first']);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      { hook: 'before_schedule', index: 0, error: 'approval required' },
    ]);
  });

  it('rejects unknown hook names at registration time', () => {
    expect(() =>
      createBunnyHookRunner([
        { name: 'not_a_hook' as never, run: async () => {} },
      ]),
    ).toThrow(/unknown Bunny hook/);
  });
});
