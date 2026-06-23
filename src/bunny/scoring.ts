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
  if (recentUrls.has(candidate.url)) {
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
