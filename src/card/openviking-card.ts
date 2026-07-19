import type { OvProviderConf } from '../openviking/service';
import { maskSecret } from '../openviking/service';

export interface OvFormOpts {
  embedding: OvProviderConf;
  vlm: OvProviderConf;
}

const EMBEDDING_PROVIDERS = ['volcengine', 'dashscope', 'openai'] as const;
const VLM_PROVIDERS = ['volcengine', 'openai', 'kimi', 'glm'] as const;

function providerSelect(
  name: string,
  current: string | undefined,
  providers: readonly string[],
): object {
  // A hand-edited ov.conf may use a provider outside the preset list (e.g.
  // 'jina'); keep it selectable so a no-touch submit doesn't rewrite it.
  const values =
    current && !providers.includes(current) ? [current, ...providers] : [...providers];
  return {
    tag: 'select_static',
    name,
    initial_option: current && values.includes(current) ? current : values[0],
    options: values.map((value) => ({
      text: { tag: 'plain_text', content: value },
      value,
    })),
  };
}

function textInput(name: string, defaultValue: string, placeholder: string): object {
  return {
    tag: 'input',
    name,
    default_value: defaultValue,
    placeholder: { tag: 'plain_text', content: placeholder },
    input_type: 'text',
  };
}

/** Form card for `/ov`: edits ov.conf (model providers + keys), then restarts the server. */
export function openvikingFormCard(opts: OvFormOpts): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'OpenViking 配置' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '🧠 **OpenViking 记忆服务配置**\n\n' +
            '提交后写入 `ov.conf` 并重启 `openviking-server` 生效。' +
            'API Key 字段留空表示保持现有值不变。',
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'openviking_form',
          elements: [
            {
              tag: 'markdown',
              content:
                '**Embedding 模型**（向量化，检索记忆用）\n' +
                `_当前 Key:${maskSecret(opts.embedding.api_key)}_`,
            },
            providerSelect('embedding_provider', opts.embedding.provider, EMBEDDING_PROVIDERS),
            textInput(
              'embedding_api_base',
              opts.embedding.api_base ?? '',
              'https://ark.cn-beijing.volces.com/api/v3',
            ),
            textInput(
              'embedding_model',
              opts.embedding.model ?? '',
              '如 doubao-embedding-vision-251215',
            ),
            textInput(
              'embedding_dimension',
              opts.embedding.dimension !== undefined ? String(opts.embedding.dimension) : '1024',
              '1024',
            ),
            textInput('embedding_api_key', '', '留空 = 保持不变'),
            {
              tag: 'markdown',
              content:
                '\n**VLM 模型**（记忆抽取与语义处理用）\n' +
                `_当前 Key:${maskSecret(opts.vlm.api_key)}_`,
            },
            providerSelect('vlm_provider', opts.vlm.provider, VLM_PROVIDERS),
            textInput(
              'vlm_api_base',
              opts.vlm.api_base ?? '',
              'https://ark.cn-beijing.volces.com/api/v3',
            ),
            textInput('vlm_model', opts.vlm.model ?? '', '如 doubao-seed-1-6-250615'),
            textInput('vlm_api_key', '', '留空 = 保持不变'),
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
                      text: { tag: 'plain_text', content: '保存并重启服务' },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'ov.submit' } }],
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
                      behaviors: [{ type: 'callback', value: { cmd: 'ov.cancel' } }],
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

export function openvikingSavedCard(opts: {
  embedding: OvProviderConf;
  vlm: OvProviderConf;
  restartOk: boolean;
  restartDetail: string;
}): object {
  const restartLine = opts.restartOk
    ? '✅ 服务已重启，健康检查通过。'
    : `⚠️ 配置已保存，但服务重启未成功：\n${opts.restartDetail}`;
  return {
    schema: '2.0',
    config: { summary: { content: 'OpenViking 配置已保存' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            `${opts.restartOk ? '✅' : '⚠️'} **OpenViking 配置已保存**\n\n` +
            `**Embedding**:\`${opts.embedding.provider}\` / \`${opts.embedding.model || '(未设置)'}\`` +
            `（Key ${maskSecret(opts.embedding.api_key)}）\n` +
            `**VLM**:\`${opts.vlm.provider}\` / \`${opts.vlm.model || '(未设置)'}\`` +
            `（Key ${maskSecret(opts.vlm.api_key)}）\n\n` +
            restartLine +
            '\n\n_发送 `/ov` 查看状态；`/ov memory on` 开启记忆注入。_',
        },
      ],
    },
  };
}

export function openvikingFailedCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '保存失败' } },
    body: {
      elements: [{ tag: 'markdown', content: `❌ OpenViking 配置保存失败：\n${reason}` }],
    },
  };
}

export function openvikingCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消,未修改 OpenViking 配置。' }],
    },
  };
}
