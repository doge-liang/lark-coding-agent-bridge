import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { spawnProcess } from '../platform/spawn';
import { OpenVikingClient } from './client';

/**
 * ov.conf management + systemd control for the local `openviking-server`
 * unit. The server validates the config strictly at startup (empty api_key /
 * model refuse to boot), so restart failures surface the journal tail for the
 * /ov card to display.
 */

export const OPENVIKING_UNIT = 'openviking-server';
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:1933';

export interface OvProviderConf {
  provider?: string;
  api_base?: string;
  api_key?: string;
  model?: string;
  dimension?: number;
  input?: string;
  max_retries?: number;
  [key: string]: unknown;
}

export interface OvConf {
  server?: Record<string, unknown>;
  embedding?: { dense?: OvProviderConf; [key: string]: unknown };
  vlm?: OvProviderConf;
  [key: string]: unknown;
}

/** Env override exists for tests and non-standard installs. */
export function defaultOvConfPath(): string {
  return process.env.OPENVIKING_CONF_PATH ?? join(homedir(), '.openviking', 'ov.conf');
}

/** Missing file → `{}` (fresh install); malformed JSON throws for the caller. */
export async function readOvConf(path = defaultOvConfPath()): Promise<OvConf> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return JSON.parse(text) as OvConf;
}

/** 0o600 like the bridge's own config — ov.conf holds model API keys. */
export async function writeOvConf(conf: OvConf, path = defaultOvConfPath()): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(conf, null, 2)}\n`, { mode: 0o600 });
}

export function maskSecret(key: string | undefined): string {
  if (!key) return '(未设置)';
  if (key.length <= 8) return '已设置';
  return `已设置（…${key.slice(-4)}）`;
}

export interface OvServiceStatus {
  /** systemd unit state: active / inactive / failed / unknown … */
  unitState: string;
  healthy: boolean;
}

export async function getServiceStatus(serverUrl: string): Promise<OvServiceStatus> {
  const [unit, healthy] = await Promise.all([
    execCapture('systemctl', ['is-active', OPENVIKING_UNIT], 5000).then(
      (r) => r.stdout.trim() || 'unknown',
      () => 'unknown',
    ),
    new OpenVikingClient(serverUrl).health(1500),
  ]);
  return { unitState: unit, healthy };
}

const RESTART_HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_POLL_INTERVAL_MS = 1500;

/**
 * Enable + restart the unit, then wait for /health. On failure returns the
 * journal tail so the card can show the actual validation error (e.g.
 * "Volcengine provider requires 'api_key' to be set").
 */
export async function restartOpenViking(
  serverUrl: string,
): Promise<{ ok: boolean; detail: string }> {
  const enable = await execCapture('systemctl', ['enable', '--now', OPENVIKING_UNIT], 15_000);
  if (enable.code !== 0) {
    return { ok: false, detail: `systemctl enable 失败：${enable.stderr.trim().slice(0, 400)}` };
  }
  const restart = await execCapture('systemctl', ['restart', OPENVIKING_UNIT], 30_000);
  if (restart.code !== 0) {
    return {
      ok: false,
      detail: `systemctl restart 失败：${restart.stderr.trim().slice(0, 400)}\n${await journalTail()}`,
    };
  }
  const client = new OpenVikingClient(serverUrl);
  const deadline = Date.now() + RESTART_HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await client.health(1500)) return { ok: true, detail: '' };
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return {
    ok: false,
    detail: `服务在 ${Math.round(RESTART_HEALTH_TIMEOUT_MS / 1000)}s 内未通过健康检查。\n${await journalTail()}`,
  };
}

async function journalTail(): Promise<string> {
  const r = await execCapture(
    'journalctl',
    ['-u', OPENVIKING_UNIT, '-n', '15', '--no-pager', '-o', 'cat'],
    10_000,
  ).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  const text = r.stdout.trim();
  return text ? `最近日志：\n${text.slice(-1200)}` : '';
}

function execCapture(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
