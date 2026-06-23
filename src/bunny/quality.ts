import { createHash } from 'node:crypto';
import type { BunnyDraft } from './types';

export type QualityResult = { ok: true; contentHash: string } | { ok: false; reason: string };

const EARNINGS_PATTERNS = [/\bguarantees?\b.+\$\d+/i, /\$\d+[kK]?\/month/i, /\bpassive income\b/i];

export function checkDraftQuality(draft: BunnyDraft, recentContentHashes: Set<string>): QualityResult {
  if (!draft.sourceUrl || !/^https?:\/\//.test(draft.sourceUrl)) {
    return { ok: false, reason: 'missing source url' };
  }

  if (draft.englishText.length < 40) {
    return { ok: false, reason: 'post too short' };
  }

  if (draft.englishText.length > 4000) {
    return { ok: false, reason: 'post too long' };
  }

  if (EARNINGS_PATTERNS.some((pattern) => pattern.test(draft.englishText))) {
    return { ok: false, reason: 'unsupported earnings claim' };
  }

  const contentHash = hash(`${draft.englishText}\n${draft.sourceUrl}`);
  if (recentContentHashes.has(contentHash)) {
    return { ok: false, reason: 'duplicate content' };
  }

  return { ok: true, contentHash };
}

export function postKeyForDraft(draft: BunnyDraft): string {
  return `bunny-${hash(`${draft.id}:${draft.sourceUrl}:${draft.englishText}`).slice(0, 16)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
