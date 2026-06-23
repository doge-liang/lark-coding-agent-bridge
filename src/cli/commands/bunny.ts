import { dirname, resolve } from 'node:path';
import { loadBunnyConfigFromEnv, resolveBunnyPaths } from '../../bunny/config';
import { BunnyEngine } from '../../bunny/engine';
import { OpenAICompatibleBunnyGenerator } from '../../bunny/generator';
import { startBunnyServer } from '../../bunny/server';
import { BunnyStore } from '../../bunny/store';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';

export interface BunnyCliOptions {
  profile?: string;
  config?: string;
  host?: string;
  port?: number;
}

export async function runBunnyServe(opts: BunnyCliOptions = {}): Promise<void> {
  const { engine } = await createBunnyEngine(opts);
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3827;
  const server = await startBunnyServer({ engine, host, port });

  console.log(`Bunny server listening at http://${host}:${server.port}`);
}

export async function runBunnyRunOnce(opts: BunnyCliOptions = {}): Promise<void> {
  const { engine, store } = await createBunnyEngine(opts);
  try {
    console.log(JSON.stringify(await engine.runOnce(), null, 2));
  } finally {
    store.close();
  }
}

export async function runBunnyStatus(opts: BunnyCliOptions = {}): Promise<void> {
  const { engine, store } = await createBunnyEngine(opts);
  try {
    console.log(JSON.stringify(engine.status(), null, 2));
  } finally {
    store.close();
  }
}

export async function runBunnyPause(opts: BunnyCliOptions = {}): Promise<void> {
  const { engine, store } = await createBunnyEngine(opts);
  try {
    engine.pause();
    console.log('Bunny paused');
  } finally {
    store.close();
  }
}

export async function runBunnyResume(opts: BunnyCliOptions = {}): Promise<void> {
  const { engine, store } = await createBunnyEngine(opts);
  try {
    engine.resume();
    console.log('Bunny resumed');
  } finally {
    store.close();
  }
}

async function createBunnyEngine(opts: BunnyCliOptions): Promise<{
  engine: BunnyEngine;
  store: BunnyStore;
}> {
  const dbFile = await resolveBunnyDbFile(opts);
  const store = new BunnyStore(dbFile);
  const runtime = loadBunnyConfigFromEnv();
  const generator = runtime.llm ? new OpenAICompatibleBunnyGenerator(runtime.llm) : undefined;
  return {
    store,
    engine: new BunnyEngine({
      store,
      ...(generator ? { generator } : {}),
    }),
  };
}

async function resolveBunnyDbFile(opts: BunnyCliOptions): Promise<string> {
  const configPath = opts.config ?? process.env.LARK_CHANNEL_CONFIG;
  const configHint: { rootDir?: string; profile?: string } = configPath
    ? appPathHintFromConfig(configPath)
    : {};
  const rootDir = configHint.rootDir;
  const profile = opts.profile
    ?? configHint.profile
    ?? (await readActiveProfile(rootDir))
    ?? (await readRootConfigActiveProfile(configPath, rootDir))
    ?? undefined;
  const appPaths = resolveAppPaths({ rootDir, ...(profile ? { profile } : {}) });
  return resolveBunnyPaths(appPaths).dbFile;
}

async function readRootConfigActiveProfile(
  configPath: string | undefined,
  rootDir: string | undefined,
): Promise<string | undefined> {
  const rootConfigPath = configPath ?? resolveAppPaths({ rootDir }).configFile;
  return (await loadRootConfig(rootConfigPath))?.activeProfile;
}

function appPathHintFromConfig(configPath: string): { rootDir: string; profile?: string } {
  const resolved = resolve(configPath);
  const normalized = resolved.replace(/\\/g, '/');
  const profileConfigMatch = normalized.match(
    /^(.*)\/profiles\/([^/]+)\/(?:lark-cli-source|lark-cli\/lark-channel)\/config\.json$/,
  );

  if (profileConfigMatch?.[1] && profileConfigMatch[2]) {
    return {
      rootDir: profileConfigMatch[1],
      profile: profileConfigMatch[2],
    };
  }

  return { rootDir: dirname(resolved) };
}
