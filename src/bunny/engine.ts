import { createHash } from 'node:crypto';
import { loadBunnyConfigFromEnv } from './config';
import { type BunnyGenerator, TemplateBunnyGenerator } from './generator';
import { checkDraftQuality, postKeyForDraft } from './quality';
import { planSchedule } from './scheduler';
import { scoreCandidate } from './scoring';
import type { BunnyStore } from './store';
import type { BunnyDraft, BunnyStatus, BunnyToday } from './types';
import { XApiAdapter } from './x-api';

export interface BunnyEngineOptions {
  store: BunnyStore;
  generator?: BunnyGenerator;
  xApi?: Pick<XApiAdapter, 'publish'>;
}

export interface BunnyRunOnceResult {
  scoredCandidates: number;
  savedTopics: number;
  generatedDrafts: number;
  qualityFailures: number;
  scheduledPosts: number;
}

export type BunnyPublishDueResult =
  | { published: 0; skipped: 'paused' }
  | {
      claimed: number;
      published: number;
      dryRun: number;
      failed: number;
    };

export class BunnyEngine {
  private readonly store: BunnyStore;
  private readonly generator: BunnyGenerator;
  private readonly xApi?: Pick<XApiAdapter, 'publish'>;

  constructor(options: BunnyEngineOptions) {
    this.store = options.store;
    this.generator = options.generator ?? new TemplateBunnyGenerator();
    this.xApi = options.xApi;
  }

  status(): BunnyStatus {
    return this.store.status();
  }

  today(nowIso = new Date().toISOString()): BunnyToday {
    return this.store.today(nowIso);
  }

  pause(): void {
    this.store.setPaused(true);
  }

  resume(): void {
    this.store.setPaused(false);
  }

  async runOnce(nowIso = new Date().toISOString()): Promise<BunnyRunOnceResult> {
    const settings = this.store.getSettings();
    const existingDrafts = this.store.listDrafts();
    const recentUrls = new Set(existingDrafts.map((draft) => draft.sourceUrl));
    const recentContentHashes = contentHashesFor(existingDrafts);

    const topics = this.store
      .listCandidates()
      .map((candidate) => scoreCandidate(candidate, recentUrls, nowIso))
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

    for (const topic of topics) {
      this.store.saveTopic(topic);
    }

    const scheduledToday = this.store.today(nowIso).scheduled.length;
    const availableSlots = Math.max(0, settings.dailyPostLimit - scheduledToday);
    const draftLimit = Math.min(availableSlots, settings.dailyCreditBudget);
    const generatedDrafts: BunnyDraft[] = [];
    const passingDrafts: BunnyDraft[] = [];
    let qualityFailures = 0;

    for (const topic of topics.slice(0, draftLimit)) {
      const draft = await this.generator.generate(topic, nowIso);
      generatedDrafts.push(draft);

      const quality = checkDraftQuality(draft, recentContentHashes);
      if (!quality.ok) {
        qualityFailures += 1;
        this.store.saveDraft({
          ...draft,
          status: 'skipped',
          qualityFailure: quality.reason,
        });
        continue;
      }

      recentContentHashes.add(quality.contentHash);
      this.store.saveDraft(draft);
      passingDrafts.push(draft);
    }

    const planned = planSchedule({
      draftIds: passingDrafts.map((draft) => draft.id),
      nowIso,
      dailyLimit: availableSlots,
    });
    const draftsById = new Map(passingDrafts.map((draft) => [draft.id, draft]));

    for (const item of planned) {
      const draft = draftsById.get(item.draftId);
      if (!draft) continue;
      const postKey = postKeyForDraft(draft);
      this.store.schedulePost({
        id: scheduledPostId(postKey),
        draftId: draft.id,
        postKey,
        publishAt: item.publishAt,
        status: 'scheduled',
      });
      this.store.saveDraft({ ...draft, status: 'scheduled' });
    }

    return {
      scoredCandidates: topics.length,
      savedTopics: topics.length,
      generatedDrafts: generatedDrafts.length,
      qualityFailures,
      scheduledPosts: planned.length,
    };
  }

  async publishDue(nowIso = new Date().toISOString()): Promise<BunnyPublishDueResult> {
    const settings = this.store.getSettings();
    if (settings.paused) {
      return { published: 0, skipped: 'paused' };
    }

    const claimed = this.store.claimDuePosts(nowIso);
    const drafts = new Map(this.store.listDrafts().map((draft) => [draft.id, draft]));
    const xApi = this.xApi ?? this.createXApi();
    let published = 0;
    let dryRun = 0;
    let failed = 0;

    for (const post of claimed) {
      const draft = drafts.get(post.draftId);
      if (!draft) {
        failed += 1;
        this.store.markFailed(post.postKey, 'draft not found');
        continue;
      }

      const result = await xApi.publish({
        postKey: post.postKey,
        text: draft.englishText,
      });

      if (result.status === 'published') {
        published += 1;
        this.store.markPublished(result.postKey, result.xPostId, result.xPostUrl, nowIso);
        continue;
      }

      if (result.status === 'dry-run') {
        dryRun += 1;
        this.store.recordEvent('dry_run_publish', `${result.postKey} ${result.message}`, nowIso);
        this.store.markPublished(
          result.postKey,
          `dry-run-${hash(result.postKey).slice(0, 12)}`,
          `dry-run:${result.postKey}`,
          nowIso,
        );
        continue;
      }

      failed += 1;
      this.store.markFailed(result.postKey, result.message);
    }

    return {
      claimed: claimed.length,
      published,
      dryRun,
      failed,
    };
  }

  private createXApi(): XApiAdapter {
    const runtime = loadBunnyConfigFromEnv();
    const settings = this.store.getSettings();
    return new XApiAdapter({
      livePublishing: settings.livePublishing,
      ...(runtime.xApi ? { bearerToken: runtime.xApi.bearerToken } : {}),
    });
  }
}

function contentHashesFor(drafts: BunnyDraft[]): Set<string> {
  const hashes = new Set<string>();
  for (const draft of drafts) {
    const quality = checkDraftQuality(draft, hashes);
    if (quality.ok) {
      hashes.add(quality.contentHash);
    }
  }
  return hashes;
}

function scheduledPostId(postKey: string): string {
  return `sched-${hash(postKey).slice(0, 12)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
