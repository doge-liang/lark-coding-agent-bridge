import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import {
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';
import { ClaudeSdkAdapter } from '../../../src/agent/claude/sdk-adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

// Output style is loaded from CLAUDE_CONFIG_DIR (falling back to ~/.claude).
// Pin it to an empty dir so these wiring assertions don't pick up whatever
// output style happens to be configured on the box running the tests.
let prevConfigDir: string | undefined;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const empty = mkdtempSync(join(tmpdir(), 'cc-noconfig-'));
  cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
  process.env.CLAUDE_CONFIG_DIR = empty;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  cleanups.splice(0).forEach((c) => c());
});

describe('ClaudeSdkAdapter system prompt wiring', () => {
  // Fake query() that records the options it was called with, then
  // immediately completes the run with a terminal result message.
  function fakeQueryCapturing(
    onCapture: (options: Record<string, unknown> | undefined) => void,
  ) {
    return ((params: { options?: Record<string, unknown> }) => {
      onCapture(params.options);
      const iterable = (async function* () {
        yield { type: 'result', subtype: 'success', session_id: 'sess-1' };
      })();
      return Object.assign(iterable, { interrupt: async () => {} });
    }) as never;
  }

  it('appends the identity-aware bridge system prompt after setBotIdentity', async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = new ClaudeSdkAdapter({ queryFn: fakeQueryCapturing((o) => (captured = o)) });
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    for await (const _ of run.events) {
      // drain to completion
    }

    expect(captured?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    });
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = new ClaudeSdkAdapter({ queryFn: fakeQueryCapturing((o) => (captured = o)) });

    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    for await (const _ of run.events) {
      // drain to completion
    }

    expect(captured?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: buildBridgeSystemPrompt(undefined),
    });
  });

  it('appends the configured output style after the bridge prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-style-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ outputStyle: 'Terse' }));
    mkdirSync(join(dir, 'output-styles'));
    writeFileSync(
      join(dir, 'output-styles', 'terse.md'),
      '---\nname: Terse\n---\n\nBe brief.',
    );
    process.env.CLAUDE_CONFIG_DIR = dir;

    let captured: Record<string, unknown> | undefined;
    const adapter = new ClaudeSdkAdapter({ queryFn: fakeQueryCapturing((o) => (captured = o)) });
    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    for await (const _ of run.events) {
      // drain to completion
    }

    const sp = captured?.systemPrompt as { append: string };
    expect(sp.append).toBe(`${buildBridgeSystemPrompt(undefined)}\n\nBe brief.`);
  });

  it('isolates from on-disk settings so ambient permissions.allow cannot bypass canUseTool', async () => {
    // Regression: with settingSources omitted the SDK loads ~/.claude/settings.json,
    // whose permissions.allow list pre-approves Write/Bash and skips canUseTool —
    // defeating the approval cards. The adapter must pin settingSources: [].
    let captured: Record<string, unknown> | undefined;
    const adapter = new ClaudeSdkAdapter({ queryFn: fakeQueryCapturing((o) => (captured = o)) });

    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    for await (const _ of run.events) {
      // drain to completion
    }

    expect(captured?.settingSources).toEqual([]);
  });
});

describe('CodexAdapter system prompt wiring', () => {
  function codexAdapter(): CodexAdapter {
    return new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: '/tmp/codex-profile',
    });
  }

  it('prefixes stdin with the identity-aware bridge system prompt after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(
      prefixBridgeSystemPrompt('hi', { openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(prefixBridgeSystemPrompt('hi', undefined));
  });
});

async function readAll(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
