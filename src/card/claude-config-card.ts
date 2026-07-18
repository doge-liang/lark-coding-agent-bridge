import type { AccessMode, ClaudePermissionMode } from '../config/permissions';

/** 'inherit' means no explicit override: mode is derived from the access level. */
export type ClaudePermissionModeChoice = ClaudePermissionMode | 'inherit';

export interface ClaudeConfigFormOpts {
  profileName: string;
  defaultWorkspace: string;
  defaultAccess: AccessMode;
  maxAccess: AccessMode;
  permissionMode: ClaudePermissionModeChoice;
  model: string;
  approvalTimeoutMinutes: string;
}

const accessOptions: Array<{ label: string; value: AccessMode }> = [
  { label: '只读(read-only)', value: 'read-only' },
  { label: '工作区可写(workspace)', value: 'workspace' },
  { label: '完全访问(full)', value: 'full' },
];

const permissionModeOptions: Array<{ label: string; value: ClaudePermissionModeChoice }> = [
  { label: '跟随访问级别(不覆盖)', value: 'inherit' },
  { label: 'default(逐项审批)', value: 'default' },
  { label: 'acceptEdits(自动接受编辑)', value: 'acceptEdits' },
  { label: 'plan(只读规划)', value: 'plan' },
  { label: 'auto(分类器放行+审批卡)', value: 'auto' },
  { label: 'bypassPermissions(全部放行)', value: 'bypassPermissions' },
];

function accessSelect(name: string, initial: AccessMode): object {
  return {
    tag: 'select_static',
    name,
    initial_option: initial,
    options: accessOptions.map((option) => ({
      text: { tag: 'plain_text', content: option.label },
      value: option.value,
    })),
  };
}

function permissionModeSelect(name: string, initial: ClaudePermissionModeChoice): object {
  const values = new Set(permissionModeOptions.map((option) => option.value));
  const initialOption = values.has(initial) ? initial : 'inherit';
  return {
    tag: 'select_static',
    name,
    initial_option: initialOption,
    options: permissionModeOptions.map((option) => ({
      text: { tag: 'plain_text', content: option.label },
      value: option.value,
    })),
  };
}

function permissionModeLabel(mode: ClaudePermissionModeChoice): string {
  return permissionModeOptions.find((option) => option.value === mode)?.label ?? mode;
}

export function claudeConfigFormCard(opts: ClaudeConfigFormOpts): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Claude profile 设置' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚙️ **Claude profile 设置**\n\n' +
            `当前 profile:\`${opts.profileName}\`\n\n` +
            '这里修改的是当前 Claude profile 的运行边界。模型也可以在 `/config` 里调整,两处写同一配置。',
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'claude_config_form',
          elements: [
            {
              tag: 'markdown',
              content:
                '**默认工作目录**\n' +
                '_用于新会话的默认 cwd。请填绝对路径或 `~/...`; 留空表示不设置默认工作目录。_',
            },
            {
              tag: 'input',
              name: 'default_workspace',
              default_value: opts.defaultWorkspace,
              placeholder: { tag: 'plain_text', content: '/path/to/workspace' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**默认权限**\n' +
                '_控制普通 run 默认给 Claude 的访问级别。不能高于最大权限。_',
            },
            accessSelect('default_access', opts.defaultAccess),
            {
              tag: 'markdown',
              content:
                '\n**最大权限**\n' +
                '_限制这个 profile 最多能提升到什么访问级别。_',
            },
            accessSelect('max_access', opts.maxAccess),
            {
              tag: 'markdown',
              content:
                '\n**权限模式**\n' +
                '_覆盖 Claude Code 的 permission mode。`auto`/`bypassPermissions` 需要最大权限为 full;跟随访问级别时按访问级别自动推导。_',
            },
            permissionModeSelect('permission_mode', opts.permissionMode),
            {
              tag: 'markdown',
              content:
                '\n**模型**\n' +
                '_写入 profile 配置的 `claude.model`,新会话生效; 留空表示使用 Claude Code 默认模型。_',
            },
            {
              tag: 'input',
              name: 'model',
              default_value: opts.model,
              placeholder: { tag: 'plain_text', content: 'fable / opus / sonnet / haiku' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**审批卡超时(分钟)**\n' +
                '_auto 模式下审批卡等待多久算超时拒绝。填正数; 留空表示使用默认值。_',
            },
            {
              tag: 'input',
              name: 'approval_timeout_minutes',
              default_value: opts.approvalTimeoutMinutes,
              placeholder: { tag: 'plain_text', content: '例如 5' },
              input_type: 'text',
            },
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: 'small',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'submit_btn',
                      text: { tag: 'plain_text', content: '提交' },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'claude-config.submit' } }],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'cancel_btn',
                      text: { tag: 'plain_text', content: '取消' },
                      behaviors: [{ type: 'callback', value: { cmd: 'claude-config.cancel' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

export function claudeConfigSavedCard(opts: ClaudeConfigFormOpts): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Claude 设置已保存' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **Claude 设置已保存**\n\n' +
            `**profile**:\`${opts.profileName}\`\n` +
            `**默认工作目录**:\`${opts.defaultWorkspace || '未设置'}\`\n` +
            `**权限**:\`${opts.defaultAccess}\` / max \`${opts.maxAccess}\`\n` +
            `**权限模式**:${permissionModeLabel(opts.permissionMode)}\n` +
            `**模型**:\`${opts.model || '默认'}\`\n` +
            `**审批卡超时**:\`${opts.approvalTimeoutMinutes || '默认'}\` 分钟\n\n` +
            '设置从新的 Claude 会话开始生效。',
        },
      ],
    },
  };
}

export function claudeConfigCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消,未修改 Claude profile。' }],
    },
  };
}

export function claudeConfigFailedCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '保存失败' } },
    body: {
      elements: [{ tag: 'markdown', content: `保存失败：${reason}` }],
    },
  };
}
