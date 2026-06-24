import { BUNNY_HOOK_DEFINITIONS, type BunnyHookName as ManifestBunnyHookName } from './manifest';

export const BUNNY_EXPLICIT_HOOK_NAMES = [
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
] as const;

export type BunnyExplicitHookName = (typeof BUNNY_EXPLICIT_HOOK_NAMES)[number];
export type BunnyHookName = BunnyExplicitHookName | ManifestBunnyHookName;

export interface BunnyHookContext {
  nowIso: string;
  [key: string]: unknown;
}

export type BunnyHookItemResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };

export interface BunnyHook {
  name: BunnyHookName;
  run(context: BunnyHookContext): void | BunnyHookItemResult | Promise<void | BunnyHookItemResult>;
}

export interface BunnyHookRunner {
  run(
    name: BunnyHookName,
    context: BunnyHookContext,
    options?: BunnyHookRunOptions,
  ): Promise<BunnyHookRunResult>;
}

export interface BunnyHookRunOptions {
  continueOnError?: boolean;
}

export interface BunnyHookFailure {
  hook: BunnyHookName;
  index: number;
  error: string;
}

export interface BunnyHookRunResult {
  hook: BunnyHookName;
  ok: boolean;
  results: BunnyHookItemResult[];
  failures: BunnyHookFailure[];
}

export const BUNNY_HOOK_NAMES: BunnyHookName[] = [
  ...BUNNY_EXPLICIT_HOOK_NAMES,
  ...BUNNY_HOOK_DEFINITIONS
    .map((hook) => hook.name)
    .filter((name) => !BUNNY_EXPLICIT_HOOK_NAMES.includes(name as BunnyExplicitHookName)),
];

const KNOWN_HOOKS = new Set<string>(BUNNY_HOOK_NAMES);

export function createBunnyHookRunner(hooks: BunnyHook[]): BunnyHookRunner {
  for (const hook of hooks) {
    if (!KNOWN_HOOKS.has(hook.name)) {
      throw new Error(`unknown Bunny hook: ${String(hook.name)}`);
    }
  }
  return {
    async run(name, context, options = {}) {
      const results: BunnyHookItemResult[] = [];
      const failures: BunnyHookFailure[] = [];
      const continueOnError = options.continueOnError !== false;
      let index = 0;

      for (const hook of hooks) {
        if (hook.name !== name) continue;
        const currentIndex = index;
        index += 1;
        try {
          const result = normalizeHookResult(await hook.run(context));
          results.push(result);
          if (!result.ok) {
            const failure = { hook: name, index: currentIndex, error: result.error };
            failures.push(failure);
            if (!continueOnError) break;
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          const failure = { hook: name, index: currentIndex, error };
          failures.push(failure);
          results.push({ ok: false, error });
          if (!continueOnError) break;
        }
      }
      return {
        hook: name,
        ok: failures.length === 0,
        results,
        failures,
      };
    },
  };
}

function normalizeHookResult(result: void | BunnyHookItemResult): BunnyHookItemResult {
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
    return result;
  }
  return { ok: true };
}
