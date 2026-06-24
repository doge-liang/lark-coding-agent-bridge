import type { BunnyEngine } from '../engine';
import { buildDailyReport } from '../reporter';
import type { BunnyStore } from '../store';
import type { BunnySkillName } from './manifest';

export interface BunnyAgentRuntimeOptions {
  engine: BunnyEngine;
  store: BunnyStore;
}

export interface BunnySkillDispatch {
  skill: BunnySkillName;
  nowIso?: string;
  confirmed?: boolean;
}

export type BunnySkillResult =
  | { ok: true; markdown: string }
  | { ok: false; markdown: string; requiresConfirmation?: boolean };

export class BunnyAgentRuntime {
  constructor(private readonly options: BunnyAgentRuntimeOptions) {}

  async dispatch(input: BunnySkillDispatch): Promise<BunnySkillResult> {
    switch (input.skill) {
      case 'research_topics':
      case 'generate_drafts': {
        const result = await this.options.engine.runOnce(input.nowIso);
        return {
          ok: true,
          markdown: [
            '**Bunny research run complete**',
            `generated: ${result.generatedDrafts}`,
            `scheduled: ${result.scheduledPosts}`,
            `quality failures: ${result.qualityFailures}`,
          ].join('\n'),
        };
      }
      case 'quality_check':
        return { ok: true, markdown: this.qualitySummary() };
      case 'review_queue':
        return { ok: true, markdown: this.reviewQueue(input.nowIso) };
      case 'schedule_posts':
        if (!input.confirmed) return confirmationRequired('Schedule posts requires explicit confirmation.');
        return { ok: true, markdown: 'Scheduling uses approved drafts produced by the Bunny engine.' };
      case 'pause_publishing':
        this.options.engine.pause();
        return { ok: true, markdown: 'Bunny publishing paused.' };
      case 'resume_publishing':
        if (!input.confirmed) return confirmationRequired('Resume publishing requires explicit confirmation.');
        this.options.engine.resume();
        return { ok: true, markdown: 'Bunny publishing resumed.' };
      case 'daily_report':
        return {
          ok: true,
          markdown: buildDailyReport(
            this.options.engine.today(input.nowIso),
            this.options.engine.status(),
            new Map(),
          ),
        };
    }
  }

  private qualitySummary(): string {
    const drafts = this.options.store.listDrafts();
    const failed = drafts.filter((draft) => draft.qualityFailure);
    return [
      '**Bunny Quality Check**',
      `drafts: ${drafts.length}`,
      `quality failures: ${failed.length}`,
      ...failed.slice(0, 5).map((draft) => `- ${draft.id}: ${draft.qualityFailure}`),
    ].join('\n');
  }

  private reviewQueue(nowIso: string | undefined): string {
    const today = this.options.engine.today(nowIso);
    return [
      '**Bunny Review Queue**',
      `scheduled: ${today.scheduled.length}`,
      `drafts: ${today.drafts.length}`,
      ...today.drafts.slice(0, 5).map((draft) => `- ${draft.id}: ${firstLine(draft.englishText)}`),
    ].join('\n');
  }
}

function confirmationRequired(markdown: string): BunnySkillResult {
  return { ok: false, markdown, requiresConfirmation: true };
}

function firstLine(value: string): string {
  return value.split('\n')[0]?.trim() || value.trim();
}
