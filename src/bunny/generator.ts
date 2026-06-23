import { createHash } from 'node:crypto';
import type { BunnyDraft, BunnyTopic } from './types';

export interface BunnyGenerator {
  generate(topic: BunnyTopic, nowIso?: string): Promise<BunnyDraft>;
}

export class TemplateBunnyGenerator implements BunnyGenerator {
  async generate(topic: BunnyTopic, nowIso = new Date().toISOString()): Promise<BunnyDraft> {
    const id = `draft-${hash(`${topic.id}:${nowIso}`).slice(0, 12)}`;

    return {
      id,
      topicId: topic.id,
      kind: topic.summary.length > 180 ? 'thread' : 'single',
      chineseNote: `中文理解: ${topic.title}\n来源: ${topic.url}\n价值: ${topic.summary}`,
      englishText: [
        `AI workflow worth studying: ${topic.title}`,
        '',
        `Why it matters: ${topic.summary}`,
        '',
        `Source: ${topic.url}`,
      ].join('\n'),
      sourceUrl: topic.url,
      status: 'draft',
      createdAt: nowIso,
    };
  }
}

export class OpenAICompatibleBunnyGenerator implements BunnyGenerator {
  constructor(private readonly opts: { endpoint: string; apiKey: string; model: string }) {}

  async generate(topic: BunnyTopic, nowIso = new Date().toISOString()): Promise<BunnyDraft> {
    const response = await fetch(this.opts.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: [
          {
            role: 'system',
            content: 'Write concise, source-grounded AI tools Twitter content. Avoid unsupported earnings claims.',
          },
          {
            role: 'user',
            content: `Topic: ${topic.title}\nSummary: ${topic.summary}\nSource: ${topic.url}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status}`);
    }

    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('LLM response had no message content');
    }

    return {
      id: `draft-${hash(`${topic.id}:${nowIso}`).slice(0, 12)}`,
      topicId: topic.id,
      kind: content.length > 280 ? 'thread' : 'single',
      chineseNote: `中文理解: ${topic.title}\n来源: ${topic.url}\n价值: ${topic.summary}`,
      englishText: content,
      sourceUrl: topic.url,
      status: 'draft',
      createdAt: nowIso,
    };
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
