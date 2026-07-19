import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  controls: Controls;
  run(content: string, overrides?: { senderId?: string }): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('/ov OpenViking command', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    delete process.env.OPENVIKING_CONF_PATH;
  });

  it('denies non-admin senders', async () => {
    const h = await createHarness();
    await expect(h.run('/ov', { senderId: 'ou-guest' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('renders the status card with masked config for admins', async () => {
    const h = await createHarness();
    process.env.OPENVIKING_CONF_PATH = join(h.tmp.root, 'ov.conf');
    await writeFile(
      process.env.OPENVIKING_CONF_PATH,
      JSON.stringify({
        embedding: {
          dense: { provider: 'volcengine', model: 'doubao-embedding', api_key: 'sk-secret-1234' },
        },
        vlm: { provider: 'volcengine', model: '', api_key: '' },
      }),
      'utf8',
    );
    await expect(h.run('/ov')).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain('OpenViking 记忆');
    expect(card).toContain('doubao-embedding');
    expect(card).toContain('1234');
    expect(card).not.toContain('sk-secret-1234');
    expect(card).toContain('(未设置)');
  });

  it('toggles memory injection and persists the preference', async () => {
    const h = await createHarness();
    await expect(h.run('/ov memory on')).resolves.toBe(true);
    expect(h.controls.cfg.preferences?.openviking?.memoryEnabled).toBe(true);
    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.preferences?.openviking?.memoryEnabled).toBe(true);
    // The refreshed status card reflects the new state.
    expect(JSON.stringify(lastContent(h.channel))).toContain('开启');

    await expect(h.run('/ov memory off')).resolves.toBe(true);
    expect(h.controls.cfg.preferences?.openviking?.memoryEnabled).toBe(false);
  });

  it('sends the config form card with keys left blank', async () => {
    const h = await createHarness();
    process.env.OPENVIKING_CONF_PATH = join(h.tmp.root, 'ov.conf');
    await writeFile(
      process.env.OPENVIKING_CONF_PATH,
      JSON.stringify({ vlm: { provider: 'volcengine', api_key: 'sk-secret-9999' } }),
      'utf8',
    );
    await expect(h.run('/ov form')).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain('ov.submit');
    expect(card).toContain('9999');
    expect(card).not.toContain('sk-secret-9999');
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('ov-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const workspaceRealpath = await realpath(tmp.workspace);
  const profileConfig = appConfig(workspaceRealpath);
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  const run = (content: string, overrides: { senderId?: string } = {}): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, overrides.senderId ?? 'ou-admin'),
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, controls, run };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    preferences: {},
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string, senderId: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId,
    senderName: 'User',
    content,
    resources: [],
    mentions: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = lastContent(channel);
  expect(content.markdown).toBeTypeOf('string');
  return content.markdown as string;
}
