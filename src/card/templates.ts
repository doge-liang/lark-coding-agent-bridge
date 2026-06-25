interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作目录。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作目录'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作目录', elements);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  activeRun: boolean;
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
  showUsage?: boolean;
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : (info.emptySessionText ?? '(无)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(未设置)';
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      ...(info.showUsage ? [{ text: '📈 用量', value: { cmd: 'usage' } }] : []),
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export interface UsageCardInfo {
  sessionId: string;
  sampledAt?: string;
  context?: {
    percent: string;
    used: string;
    window: string;
  };
  recent?: {
    total: string;
    input?: string;
    cached?: string;
    output?: string;
    reasoning?: string;
  };
  cumulative?: {
    total: string;
    input?: string;
    cached?: string;
    output?: string;
    reasoning?: string;
  };
  rateLimits?: {
    primary?: string;
    secondary?: string;
  };
}

export function usageCard(info: UsageCardInfo): object {
  const elements: object[] = [];
  if (info.context) {
    elements.push(
      divMd(
        [
          `**当前上下文  ${escapeMd(info.context.percent)}**`,
          `\`${escapeCode(info.context.used)} / ${escapeCode(info.context.window)}\``,
        ].join('\n'),
      ),
    );
  } else {
    elements.push(divMd('**当前上下文**\n暂无窗口快照'));
  }

  if (info.recent) {
    elements.push(HR);
    elements.push(divMd(`**最近请求**\n${usageMetricLine('本轮', info.recent)}`));
  }

  if (info.cumulative) {
    elements.push(divMd(`**累计消耗**\n${usageMetricLine('累计', info.cumulative)}`));
  }

  const limits = [info.rateLimits?.primary, info.rateLimits?.secondary].filter(Boolean);
  if (limits.length > 0) {
    elements.push(HR);
    elements.push(divMd(`**Rate limit**\n${limits.map((limit) => escapeMd(limit!)).join('\n')}`));
  }

  elements.push(HR);
  elements.push(
    divMd(
      [
        `session \`${escapeCode(info.sessionId)}\`${info.sampledAt ? ` · ${escapeMd(info.sampledAt)}` : ''}`,
        '_当前上下文按最近一次 token_count 估算；累计消耗不是上下文长度。_',
      ].join('\n'),
    ),
  );
  elements.push(
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
    ]),
  );
  return shell('📈 Codex 用量', elements);
}

function usageMetricLine(label: string, usage: NonNullable<UsageCardInfo['recent']>): string {
  const parts = [`${label} ${usage.total}`];
  if (usage.input) parts.push(`输入 ${usage.input}`);
  if (usage.cached) parts.push(`缓存 ${usage.cached}`);
  if (usage.output) parts.push(`输出 ${usage.output}`);
  if (usage.reasoning) parts.push(`思考 ${usage.reasoning}`);
  return parts.map(escapeMd).join(' · ');
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? '已是当前会话' : '▸ 恢复此会话',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复历史会话', elements);
}

export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return shell('💡 使用帮助', [
    divMd(
      [
        '**命令列表**',
        '',
        '- `/new` `/reset` — 清空当前 chat 的会话',
        '- `/new chat [name]` — 新建群+新会话，自动拉你进群',
        '- `/resume [N]` — 列出并恢复历史会话（最多 N 条）',
        '- `/cd <path>` — 切换工作目录（会重置 session）',
        '- `/ws list|save <name>|use <name>|remove <name>` — 工作目录',
        '- `/account` — 查看当前应用；`/account change` 换 appId/secret 并重连',
        '- `/config` — 调整偏好、访问控制和 lark-cli 身份策略',
        '- `/codex-config` — 调整当前 Codex profile 的权限、默认工作目录和 Codex home',
        '- `/status` — 当前状态',
        '- `/usage` — 查看当前 Codex session 的 token 用量和上下文窗口',
        '- `/menu` — 查看飞书机器人悬浮菜单配置建议',
        '- `/stop` — 结束当前正在跑的任务（也可点卡片底部 ⏹ 终止 按钮）',
        '- `/stop comment:<scopeHash>` — 管理员停止云文档评论任务',
        '- `/timeout [N|off|default]` — 当前 session 的探活分钟数,`/config` 改全局默认',
        '- `/timeout comment:<scopeHash> N` — 管理员设置云文档评论任务探活',
        '- `/ps` — 列出本机所有 bot,标识当前正在回复的那个',
        '- `/exit <id|#>` — 关掉指定 bot(用 `/ps` 看 id/序号)',
        '- `/reconnect` — 强制重连 WebSocket(网络抖动后 bot 没反应时用)',
        `- \`/doctor [描述]\` — 把日志和描述交给 ${escapedAgentName} 自助诊断`,
        '- `/upgrade [status|check|apply|rollback]` — 管理员私聊执行受控自更新',
        '- `/help` — 本帮助',
        '',
        `其他内容直接交给 ${escapedAgentName}。`,
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '📈 用量', value: { cmd: 'usage' } },
      { text: '☰ 菜单', value: { cmd: 'menu' } },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '🆕 新会话', value: { cmd: 'new' } },
    ]),
  ]);
}

export function menuCard(agentName = 'Agent'): object {
  return shell('☰ 飞书悬浮菜单', [
    divMd(
      [
        `为 ${escapeMd(agentName)} 配置机器人自定义菜单：`,
        '',
        '**开发者后台路径**',
        '开放平台应用 → 添加应用能力 → 机器人 → 机器人自定义菜单',
        '',
        '**菜单设置**',
        '- 菜单状态：开启',
        '- 展示样式：悬浮菜单',
        '- 响应动作：发送文字消息',
      ].join('\n'),
    ),
    HR,
    divMd(
      [
        '**一级菜单建议**',
        '- `用量` → `/usage`',
        '- `Bunny` → `Bunny`',
        '- `Bunny 选题` → `Bunny 选题`',
        '- `Bunny 草稿` → `Bunny 草稿`',
        '- `Bunny 审稿` → `Bunny 审稿`',
        '- `Bunny 排期` → `Bunny 排期`',
        '- `Bunny 日报` → `Bunny 日报`',
        '- `状态` → `/status`',
        '- `新对话` → `/new`',
        '- `新会话` 也会映射到 `/new`',
        '- `恢复` → `/resume`',
        '- `更多` → 放二级菜单',
        '',
        '**更多 / 二级菜单建议**',
        '- `帮助` → `/help`',
        '- `菜单` → `/menu`',
        '- `工作目录` → `/ws`',
        '- `配置` → `/config`',
        '- `Codex 设置` → `/codex-config`',
        '- `升级检查` → `/upgrade check`',
        '- `停止` → `/stop`',
      ].join('\n'),
    ),
    HR,
    divMd(
      [
        '**说明**',
        '这些菜单文案已内置为精确入口；用户点击后，飞书会把菜单文案作为消息发送给 bot。',
        'Bunny 入口只走精确菜单文字和 Bunny 首页卡片按钮，业务动作需要显式触发。',
        '悬浮菜单仅支持单聊，客户端需要飞书 7.22 及以上；应用版本发布后通常需等待约 5 分钟生效。',
      ].join('\n'),
    ),
    actions([
      { text: '📈 用量', value: { cmd: 'usage' }, style: 'primary' },
      { text: '📊 状态', value: { cmd: 'status' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
