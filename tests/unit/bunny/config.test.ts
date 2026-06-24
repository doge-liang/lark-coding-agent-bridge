import { describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  defaultBunnySettings,
  loadBunnyConfigFromEnv,
  resolveBunnyPaths,
} from '../../../src/bunny/config';

describe('bunny config', () => {
  it('derives profile-local Bunny paths', () => {
    const appPaths = resolveAppPaths({ rootDir: '/tmp/lark-home', profile: 'codex-dev' });
    const paths = resolveBunnyPaths(appPaths);

    expect(paths.rootDir).toBe('/tmp/lark-home/profiles/codex-dev/bunny');
    expect(paths.dbFile).toBe('/tmp/lark-home/profiles/codex-dev/bunny/bunny.sqlite');
    expect(paths.logDir).toBe('/tmp/lark-home/profiles/codex-dev/bunny/logs');
  });

  it('uses conservative default settings', () => {
    expect(defaultBunnySettings()).toEqual({
      paused: false,
      livePublishing: false,
      dailyPostLimit: 2,
      threadCadenceDays: 3,
      firstLiveWeekDailyLimit: 1,
      dryRunDays: 3,
      dailyCreditBudget: 50,
      timezone: 'UTC',
    });
  });

  it('loads runtime config from explicit environment values', () => {
    const cfg = loadBunnyConfigFromEnv({
      BUNNY_BASE_URL: 'http://127.0.0.1:3827',
      BUNNY_X_BEARER_TOKEN: 'x-token',
      BUNNY_LLM_ENDPOINT: 'https://llm.example.test/v1/chat/completions',
      BUNNY_LLM_API_KEY: 'llm-key',
      BUNNY_LLM_MODEL: 'agent-model',
    });

    expect(cfg).not.toHaveProperty('baseUrl');
    expect(cfg).not.toHaveProperty('xBearerToken');
    expect(cfg.xApi).toEqual({
      bearerToken: 'x-token',
    });
    expect(cfg.llm).toEqual({
      endpoint: 'https://llm.example.test/v1/chat/completions',
      apiKey: 'llm-key',
      model: 'agent-model',
    });
  });

  it('omits optional runtime integrations when environment values are incomplete', () => {
    const cfg = loadBunnyConfigFromEnv({
      BUNNY_BASE_URL: 'http://127.0.0.1:3827',
      BUNNY_X_BEARER_TOKEN: '   ',
      BUNNY_LLM_ENDPOINT: 'https://llm.example.test/v1/chat/completions',
      BUNNY_LLM_API_KEY: 'llm-key',
    });

    expect(cfg).toEqual({});
  });
});
