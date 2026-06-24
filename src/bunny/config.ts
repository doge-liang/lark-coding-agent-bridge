import { join } from 'node:path';
import type { AppPaths } from '../config/app-paths';
import type { BunnyRuntimeConfig, BunnySettings } from './types';

export interface BunnyPaths {
  rootDir: string;
  dbFile: string;
  logDir: string;
}

export function resolveBunnyPaths(appPaths: Pick<AppPaths, 'profileDir'>): BunnyPaths {
  const rootDir = join(appPaths.profileDir, 'bunny');
  return {
    rootDir,
    dbFile: join(rootDir, 'bunny.sqlite'),
    logDir: join(rootDir, 'logs'),
  };
}

export function defaultBunnySettings(): BunnySettings {
  return {
    paused: false,
    livePublishing: false,
    dailyPostLimit: 2,
    threadCadenceDays: 3,
    firstLiveWeekDailyLimit: 1,
    dryRunDays: 3,
    dailyCreditBudget: 50,
    timezone: 'UTC',
  };
}

export function loadBunnyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BunnyRuntimeConfig {
  const endpoint = nonEmpty(env.BUNNY_LLM_ENDPOINT);
  const apiKey = nonEmpty(env.BUNNY_LLM_API_KEY);
  const model = nonEmpty(env.BUNNY_LLM_MODEL);
  const bearer = nonEmpty(env.BUNNY_X_BEARER_TOKEN);
  return {
    ...(bearer ? { xApi: { bearerToken: bearer } } : {}),
    ...(endpoint && apiKey && model ? { llm: { endpoint, apiKey, model } } : {}),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}
