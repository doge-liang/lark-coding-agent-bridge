import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface CodexRateLimit {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface CodexUsageSnapshot {
  ok: true;
  threadId: string;
  sessionFile: string;
  timestamp?: string;
  last?: TokenUsage;
  total?: TokenUsage;
  contextWindow?: number;
  rateLimits?: {
    primary?: CodexRateLimit;
    secondary?: CodexRateLimit;
  };
}

export type CodexUsageResult =
  | CodexUsageSnapshot
  | { ok: false; reason: 'not-found' | 'no-token-count' | 'read-failed'; message?: string };

export interface ReadCodexUsageOptions {
  codexHome?: string;
}

export async function readCodexUsageForThread(
  threadId: string,
  options: ReadCodexUsageOptions = {},
): Promise<CodexUsageResult> {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  let sessionFile: string | undefined;
  try {
    sessionFile = await findSessionFile(join(codexHome, 'sessions'), threadId);
  } catch (err) {
    return { ok: false, reason: 'read-failed', message: errorMessage(err) };
  }
  if (!sessionFile) return { ok: false, reason: 'not-found' };

  try {
    const snapshot = parseUsageFile(threadId, sessionFile, await readFile(sessionFile, 'utf8'));
    return snapshot ?? { ok: false, reason: 'no-token-count' };
  } catch (err) {
    return { ok: false, reason: 'read-failed', message: errorMessage(err) };
  }
}

async function findSessionFile(sessionsDir: string, threadId: string): Promise<string | undefined> {
  const suffix = `${threadId}.jsonl`;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  const stack = [sessionsDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        const info = await stat(fullPath);
        candidates.push({ path: fullPath, mtimeMs: info.mtimeMs });
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path;
}

function parseUsageFile(
  threadId: string,
  sessionFile: string,
  text: string,
): CodexUsageSnapshot | undefined {
  let latest: CodexUsageSnapshot | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = recordValue(parsed);
    const payload = recordValue(record?.payload);
    if (record?.type !== 'event_msg' || payload?.type !== 'token_count') continue;
    const info = recordValue(payload.info);
    if (!info) continue;
    latest = {
      ok: true,
      threadId,
      sessionFile,
      ...(stringValue(record.timestamp) ? { timestamp: stringValue(record.timestamp) } : {}),
      ...(parseTokenUsage(info.last_token_usage ?? info.lastTokenUsage)
        ? { last: parseTokenUsage(info.last_token_usage ?? info.lastTokenUsage)! }
        : {}),
      ...(parseTokenUsage(info.total_token_usage ?? info.totalTokenUsage)
        ? { total: parseTokenUsage(info.total_token_usage ?? info.totalTokenUsage)! }
        : {}),
      ...(numberValue(info.model_context_window ?? info.modelContextWindow)
        ? { contextWindow: numberValue(info.model_context_window ?? info.modelContextWindow) }
        : {}),
      ...(parseRateLimits(payload.rate_limits ?? payload.rateLimits)
        ? { rateLimits: parseRateLimits(payload.rate_limits ?? payload.rateLimits)! }
        : {}),
    };
  }
  return latest;
}

function parseTokenUsage(input: unknown): TokenUsage | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const usage: TokenUsage = {
    ...(numberValue(raw.input_tokens ?? raw.inputTokens) !== undefined
      ? { inputTokens: numberValue(raw.input_tokens ?? raw.inputTokens) }
      : {}),
    ...(numberValue(raw.cached_input_tokens ?? raw.cachedInputTokens) !== undefined
      ? { cachedInputTokens: numberValue(raw.cached_input_tokens ?? raw.cachedInputTokens) }
      : {}),
    ...(numberValue(raw.output_tokens ?? raw.outputTokens) !== undefined
      ? { outputTokens: numberValue(raw.output_tokens ?? raw.outputTokens) }
      : {}),
    ...(numberValue(raw.reasoning_output_tokens ?? raw.reasoningOutputTokens) !== undefined
      ? { reasoningOutputTokens: numberValue(raw.reasoning_output_tokens ?? raw.reasoningOutputTokens) }
      : {}),
    ...(numberValue(raw.total_tokens ?? raw.totalTokens) !== undefined
      ? { totalTokens: numberValue(raw.total_tokens ?? raw.totalTokens) }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function parseRateLimits(input: unknown): CodexUsageSnapshot['rateLimits'] | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const primary = parseRateLimit(raw.primary);
  const secondary = parseRateLimit(raw.secondary);
  if (!primary && !secondary) return undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

function parseRateLimit(input: unknown): CodexRateLimit | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const limit: CodexRateLimit = {
    ...(numberValue(raw.used_percent ?? raw.usedPercent) !== undefined
      ? { usedPercent: numberValue(raw.used_percent ?? raw.usedPercent) }
      : {}),
    ...(numberValue(raw.window_minutes ?? raw.windowMinutes) !== undefined
      ? { windowMinutes: numberValue(raw.window_minutes ?? raw.windowMinutes) }
      : {}),
    ...(numberValue(raw.resets_at ?? raw.resetsAt) !== undefined
      ? { resetsAt: numberValue(raw.resets_at ?? raw.resetsAt) }
      : {}),
  };
  return Object.keys(limit).length > 0 ? limit : undefined;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
