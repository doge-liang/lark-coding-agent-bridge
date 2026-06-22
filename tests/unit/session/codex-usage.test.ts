import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodexUsageForThread } from '../../../src/session/codex-usage.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('Codex usage reader', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('reads the latest token_count event for a thread session file', async () => {
    const tmp = await createTmpProfile('codex-usage-');
    cleanups.push(tmp.cleanup);
    const codexHome = join(tmp.root, 'codex-home');
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '21');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-2026-06-21T10-00-00-thread-current.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-06-21T10:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
              last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
              model_context_window: 200_000,
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-21T10:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 300,
                cached_input_tokens: 120,
                output_tokens: 25,
                reasoning_output_tokens: 7,
                total_tokens: 325,
              },
              last_token_usage: {
                input_tokens: 200,
                cached_input_tokens: 80,
                output_tokens: 15,
                reasoning_output_tokens: 4,
                total_tokens: 215,
              },
              model_context_window: 200_000,
            },
            rate_limits: {
              primary: { used_percent: 12, window_minutes: 300, resets_at: 1_782_058_661 },
              secondary: { used_percent: 34, window_minutes: 10080, resets_at: 1_782_590_960 },
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    await expect(readCodexUsageForThread('thread-current', { codexHome })).resolves.toMatchObject({
      ok: true,
      threadId: 'thread-current',
      timestamp: '2026-06-21T10:00:02.000Z',
      contextWindow: 200_000,
      last: {
        inputTokens: 200,
        cachedInputTokens: 80,
        outputTokens: 15,
        reasoningOutputTokens: 4,
        totalTokens: 215,
      },
      total: {
        inputTokens: 300,
        cachedInputTokens: 120,
        outputTokens: 25,
        reasoningOutputTokens: 7,
        totalTokens: 325,
      },
      rateLimits: {
        primary: { usedPercent: 12, windowMinutes: 300, resetsAt: 1_782_058_661 },
        secondary: { usedPercent: 34, windowMinutes: 10080, resetsAt: 1_782_590_960 },
      },
    });
  });

  it('reports not-found when no session file matches the thread id', async () => {
    const tmp = await createTmpProfile('codex-usage-missing-');
    cleanups.push(tmp.cleanup);

    await expect(
      readCodexUsageForThread('thread-missing', { codexHome: join(tmp.root, 'codex-home') }),
    ).resolves.toEqual({ ok: false, reason: 'not-found' });
  });
});
