import type { AccessMode } from '../config/permissions';

export type CodexHomeMode = 'inherit' | 'profile' | 'custom';

export interface CodexConfigFormOpts {
  profileName: string;
  binaryPath: string;
  defaultWorkspace: string;
  defaultAccess: AccessMode;
  maxAccess: AccessMode;
  model: string;
  modelReasoningEffort: string;
  codexConfigFile: string;
  codexHomeMode: CodexHomeMode;
  codexHomePath: string;
  profileCodexHomePath: string;
  ignoreUserConfig: boolean;
  ignoreRules: boolean;
}

const accessOptions: Array<{ label: string; value: AccessMode }> = [
  { label: '只读(read-only)', value: 'read-only' },
  { label: '工作区可写(workspace)', value: 'workspace' },
  { label: '完全访问(full)', value: 'full' },
];

const reasoningEffortOptions = [
  { label: '默认(不写入)', value: 'default' },
  { label: 'minimal', value: 'minimal' },
  { label: 'low', value: 'low' },
  { label: 'medium', value: 'medium' },
  { label: 'high', value: 'high' },
  { label: 'xhigh', value: 'xhigh' },
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

function reasoningEffortSelect(name: string, initial: string): object {
  const values = new Set(reasoningEffortOptions.map((option) => option.value));
  const initialOption = initial && values.has(initial) ? initial : 'default';
  return {
    tag: 'select_static',
    name,
    initial_option: initialOption,
    options: reasoningEffortOptions.map((option) => ({
      text: { tag: 'plain_text', content: option.label },
      value: option.value,
    })),
  };
}

function yesNoSelect(name: string, initial: boolean): object {
  return {
    tag: 'select_static',
    name,
    initial_option: initial ? 'yes' : 'no',
    options: [
      { text: { tag: 'plain_text', content: '是' }, value: 'yes' },
      { text: { tag: 'plain_text', content: '否' }, value: 'no' },
    ],
  };
}

function homeModeLabel(mode: CodexHomeMode, opts: CodexConfigFormOpts): string {
  switch (mode) {
    case 'custom':
      return opts.codexHomePath ? `自定义目录(${opts.codexHomePath})` : '自定义目录';
    case 'profile':
      return `当前 profile 独立目录(${opts.profileCodexHomePath})`;
    case 'inherit':
      return '继承用户 Codex home';
  }
}

export function codexConfigFormCard(opts: CodexConfigFormOpts): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Codex profile 设置' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚙️ **Codex profile 设置**\n\n' +
            `当前 profile:\`${opts.profileName}\`\n` +
            `Codex binary:\`${opts.binaryPath}\`\n\n` +
            '这里修改的是当前 Codex profile 的运行边界。关键业务入口仍建议走显式 command 或菜单触发。',
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'codex_config_form',
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
                '_控制普通 run 默认给 Codex 的访问级别。不能高于最大权限。_',
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
                '\n**模型**\n' +
                '_写入当前 Codex home 的 `config.toml` 顶层 `model` 和 `model_reasoning_effort`; 留空/默认表示删除对应项并使用 Codex 默认或上层配置。_\n' +
                `config:\`${opts.codexConfigFile}\``,
            },
            {
              tag: 'input',
              name: 'model',
              default_value: opts.model,
              placeholder: { tag: 'plain_text', content: 'gpt-5.5' },
              input_type: 'text',
            },
            reasoningEffortSelect('model_reasoning_effort', opts.modelReasoningEffort),
            {
              tag: 'markdown',
              content:
                '\n**Codex home**\n' +
                '_继承:沿用当前用户的 Codex 登录和历史; profile 独立:使用本 profile 私有目录; 自定义:使用下面填写的目录。_\n' +
                `profile 独立目录:\`${opts.profileCodexHomePath}\``,
            },
            {
              tag: 'select_static',
              name: 'codex_home_mode',
              initial_option: opts.codexHomeMode,
              options: [
                { text: { tag: 'plain_text', content: '继承用户 Codex home' }, value: 'inherit' },
                { text: { tag: 'plain_text', content: '当前 profile 独立目录' }, value: 'profile' },
                { text: { tag: 'plain_text', content: '自定义目录' }, value: 'custom' },
              ],
            },
            {
              tag: 'input',
              name: 'codex_home_path',
              default_value: opts.codexHomePath,
              placeholder: { tag: 'plain_text', content: '/path/to/codex-home' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**忽略用户 Codex 配置**\n' +
                '_是:启动 Codex 时加 `--ignore-user-config`; 否:读取用户配置。_',
            },
            yesNoSelect('ignore_user_config', opts.ignoreUserConfig),
            {
              tag: 'markdown',
              content:
                '\n**忽略 Codex 规则文件**\n' +
                '_是:启动 Codex 时加 `--ignore-rules`; 否:读取规则文件。_',
            },
            yesNoSelect('ignore_rules', opts.ignoreRules),
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
                      behaviors: [{ type: 'callback', value: { cmd: 'codex-config.submit' } }],
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
                      behaviors: [{ type: 'callback', value: { cmd: 'codex-config.cancel' } }],
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

export function codexConfigSavedCard(opts: CodexConfigFormOpts): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Codex 设置已保存' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **Codex 设置已保存**\n\n' +
            `**profile**:\`${opts.profileName}\`\n` +
            `**默认工作目录**:\`${opts.defaultWorkspace || '未设置'}\`\n` +
            `**权限**:\`${opts.defaultAccess}\` / max \`${opts.maxAccess}\`\n` +
            `**模型**:\`${opts.model || '默认'}\` / effort \`${opts.modelReasoningEffort || '默认'}\`\n` +
            `**Codex config**:\`${opts.codexConfigFile}\`\n` +
            `**Codex home**:${homeModeLabel(opts.codexHomeMode, opts)}\n` +
            `**忽略用户配置**:\`${opts.ignoreUserConfig ? '是' : '否'}\`\n` +
            `**忽略规则文件**:\`${opts.ignoreRules ? '是' : '否'}\`\n\n` +
            '权限、默认工作目录和模型配置从新的 Codex 会话开始生效。Codex home、用户配置、规则文件设置需要重启当前 profile 后完全生效。',
        },
      ],
    },
  };
}

export function codexConfigCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消,未修改 Codex profile。' }],
    },
  };
}

export function codexConfigFailedCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '保存失败' } },
    body: {
      elements: [{ tag: 'markdown', content: `保存失败：${reason}` }],
    },
  };
}
