import { dirname } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import type { CommandContext } from '../../commands';
import { resolveAppPaths } from '../../config/app-paths';
import { log } from '../../core/logger';
import { resolveBunnyPaths } from '../config';
import { BunnyStore } from '../store';
import {
  bunnyActionPayload,
  bunnyHomeCard,
  bunnySkillForAction,
  isBunnyAgentAction,
  type BunnyAgentAction,
} from './cards';
import { bunnyScopeFor, bunnySkillEventContent } from './bridge';
import { BUNNY_AGENT_MANIFEST, type BunnySkillName } from './manifest';

export type BunnyEntryAction = BunnyAgentAction | 'home';
export type BunnyEntrySource = 'lark-menu' | 'lark-card';

const BUNNY_MENU_ACTIONS = new Map<string, BunnyEntryAction>([
  ['Bunny', 'home'],
  ['bunny', 'home'],
  ['兔子', 'home'],
  ['Bunny 选题', 'research'],
  ['Bunny 草稿', 'draft'],
  ['Bunny 审稿', 'review'],
  ['Bunny 排期', 'schedule'],
  ['Bunny 日报', 'report'],
  ['Bunny 暂停', 'pause'],
  ['Bunny 恢复', 'resume'],
]);

export function parseBunnyMenuAction(text: string): BunnyEntryAction | undefined {
  return BUNNY_MENU_ACTIONS.get(text.trim());
}

export function parseBunnyCardAction(payload: Record<string, unknown>): BunnyAgentAction | undefined {
  if (payload.domain !== 'bunny') return undefined;
  const action = payload.bunny_action;
  return isBunnyAgentAction(action) ? action : undefined;
}

export async function handleBunnyEntry(
  ctx: CommandContext,
  action: BunnyEntryAction,
  source: BunnyEntrySource,
): Promise<void> {
  if (action === 'home' || action === 'status') {
    await sendBunnyHome(ctx);
    return;
  }
  if (ctx.controls.profileConfig.agentKind !== 'codex') {
    await sendMarkdown(ctx, 'Bunny 需要当前 profile 使用 Codex agent。请切到 Codex profile 后再执行 Bunny 动作。');
    return;
  }
  if (!ctx.pending) {
    await sendMarkdown(ctx, '当前 bridge 运行环境不支持 Bunny 事件队列，请重启后再试。');
    return;
  }

  const skill = bunnySkillForAction(action);
  const bunnyScope = bunnyScopeFor(ctx.scope);
  const inheritedCwd = ctx.workspaces.cwdFor(ctx.scope);
  if (inheritedCwd && !ctx.workspaces.cwdFor(bunnyScope)) {
    ctx.workspaces.setCwd(bunnyScope, inheritedCwd);
  }

  const size = ctx.pending.push(
    bunnyScope,
    makeBunnySyntheticMessage(ctx, action, skill, source),
  );
  log.info('bunny', 'queued', {
    scope: bunnyScope,
    action,
    skill,
    source,
    queueSize: size,
  });
  if (source === 'lark-menu') {
    await sendMarkdown(ctx, `Bunny 已收到：${bunnyActionLabel(action)}。`);
  }
}

async function sendBunnyHome(ctx: CommandContext): Promise<void> {
  let store: BunnyStore | undefined;
  try {
    const paths = resolveBunnyPaths(commandProfilePaths(ctx));
    store = new BunnyStore(paths.dbFile);
    const now = new Date().toISOString();
    await ctx.channel.send(
      ctx.msg.chatId,
      { card: bunnyHomeCard({ status: store.status(), today: store.today(now) }) },
      { replyTo: ctx.msg.messageId },
    );
  } catch (err) {
    log.fail('bunny', err, { step: 'home' });
    await sendMarkdown(ctx, `Bunny 首页打开失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    store?.close();
  }
}

function makeBunnySyntheticMessage(
  ctx: CommandContext,
  action: BunnyAgentAction,
  skill: BunnySkillName | undefined,
  source: BunnyEntrySource,
): NormalizedMessage {
  return {
    messageId: ctx.msg.messageId,
    chatId: ctx.msg.chatId,
    chatType: ctx.msg.chatType,
    threadId: ctx.msg.threadId,
    senderId: ctx.msg.senderId,
    senderName: ctx.msg.senderName,
    content: bunnySkillEventContent({
      action,
      ...(skill ? { skill } : {}),
      source,
      confirmed: false,
    }),
    rawContentType: 'bunny_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}

function bunnyActionLabel(action: BunnyAgentAction): string {
  const skill = bunnyActionPayload(action).bunny_skill;
  const definition = typeof skill === 'string'
    ? BUNNY_AGENT_MANIFEST.skills.find((candidate) => candidate.name === skill)
    : undefined;
  return definition?.label ?? action;
}

function commandProfilePaths(ctx: CommandContext) {
  return resolveAppPaths({
    rootDir: dirname(ctx.controls.configPath),
    profile: ctx.controls.profile,
  });
}

async function sendMarkdown(ctx: CommandContext, markdown: string): Promise<void> {
  await ctx.channel.send(ctx.msg.chatId, { markdown }, { replyTo: ctx.msg.messageId });
}
