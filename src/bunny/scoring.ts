import { createHash } from 'node:crypto';
import type { BunnyCandidate, BunnyTopic } from './types';

export function scoreCandidate(
  candidate: BunnyCandidate,
  recentUrls: Set<string>,
  nowIso = new Date().toISOString(),
): BunnyTopic {
  const text = `${candidate.title} ${candidate.summary}`.toLowerCase();
  let score = 40;
  const reasons: string[] = [];
  const normalizedRecentUrls = new Set([...recentUrls].map((url) => normalizeUrl(url)));
  const candidateUrl = normalizeUrl(candidate.url);

  if (text.includes('workflow') || text.includes('automation')) {
    score += 30;
    reasons.push('workflow');
  }
  if (text.includes('agent') || text.includes('ai tool')) {
    score += 15;
    reasons.push('ai-tool');
  }
  if (text.includes('step-by-step') || text.includes('tutorial')) {
    score += 10;
    reasons.push('tutorial');
  }
  if (normalizedRecentUrls.has(candidateUrl)) {
    score -= 60;
    reasons.push('recent-duplicate');
  }

  return {
    id: `topic-${hash(candidate.url).slice(0, 12)}`,
    candidateId: candidate.id,
    title: candidate.title,
    url: candidate.url,
    summary: candidate.summary,
    score: Math.max(0, Math.min(100, score)),
    reason: reasons.length ? reasons.join(',') : 'general-ai-tool',
    createdAt: nowIso,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    parsed.pathname = trimTrailingSlash(parsed.pathname);
    parsed.searchParams.forEach((_, key) => {
      const lowered = key.toLowerCase();
      if (lowered === 'utm' || lowered.startsWith('utm_')) {
        parsed.searchParams.delete(key);
      }
    });

    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function trimTrailingSlash(pathname: string): string {
  if (pathname.length <= 1) {
    return '/';
  }
  return pathname.replace(/\/+$/, '');
}
