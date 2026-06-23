import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import type { BunnyCandidate } from './types';

const parser = new Parser();

export async function candidatesFromFeedXml(sourceId: string, xml: string): Promise<BunnyCandidate[]> {
  const feed = await parser.parseString(xml);
  return feed.items.flatMap((item) => {
    const title = item.title?.trim();
    const url = item.link?.trim();
    if (!title || !url) return [];

    const discoveredAt = dateIso(item.isoDate ?? item.pubDate) ?? new Date().toISOString();

    return [
      {
        id: `${sourceId}:${hash(url).slice(0, 12)}`,
        sourceId,
        title,
        url,
        summary: stripHtml(item.contentSnippet ?? item.content ?? item.summary ?? item.title ?? ''),
        discoveredAt,
      },
    ];
  });
}

export function manualCandidate(input: {
  title: string;
  url: string;
  summary: string;
  nowIso: string;
}): BunnyCandidate {
  return {
    id: `manual:${hash(input.url).slice(0, 12)}`,
    sourceId: 'manual',
    title: input.title.trim(),
    url: input.url.trim(),
    summary: input.summary.trim(),
    discoveredAt: input.nowIso,
  };
}

export async function fetchFeedCandidates(sourceId: string, feedUrl: string): Promise<BunnyCandidate[]> {
  const response = await fetch(feedUrl);
  if (!response.ok) {
    throw new Error(`feed fetch failed ${sourceId}: ${response.status}`);
  }

  const xml = await response.text();
  return candidatesFromFeedXml(sourceId, xml);
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function dateIso(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
