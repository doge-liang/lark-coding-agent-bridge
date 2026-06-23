import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { candidatesFromFeedXml, manualCandidate } from '../../../src/bunny/sources';

describe('Bunny sources', () => {
  it('parses RSS feed items into candidates', async () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>AI Tools</title>
    <item>
      <title>Browser agent workflow</title>
      <link>https://example.test/browser-agent</link>
      <description>Automate research with a browser agent.</description>
      <pubDate>Tue, 23 Jun 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    const candidates = await candidatesFromFeedXml('feed-ai-tools', xml);

    expect(candidates).toEqual([
      {
        id: 'feed-ai-tools:66fa5fd39f1f',
        sourceId: 'feed-ai-tools',
        title: 'Browser agent workflow',
        url: 'https://example.test/browser-agent',
        summary: 'Automate research with a browser agent.',
        discoveredAt: '2026-06-23T10:00:00.000Z',
      },
    ]);
  });

  it('creates manual candidates from user-submitted links', () => {
    const candidate = manualCandidate({
      title: 'AI workflow checklist',
      url: '   https://example.test/checklist   ',
        summary: 'A checklist for evaluating AI tools.',
      nowIso: '2026-06-23T11:00:00.000Z',
    });

    const url = 'https://example.test/checklist';
    const expectedId = `manual:${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;

    expect(candidate).toMatchObject({
      id: expectedId,
      sourceId: 'manual',
      title: 'AI workflow checklist',
      url,
    });
  });
});
