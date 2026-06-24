import { describe, expect, it } from 'vitest';
import {
  BUNNY_AGENT_ACTIONS,
  bunnyActionPayload,
  bunnyHomeCard,
} from '../../../src/bunny/agent/cards';
import type { BunnyStatus, BunnyToday } from '../../../src/bunny/types';

describe('Bunny agent cards', () => {
  it('builds stable Bunny action payloads without bridge callback tokens', () => {
    expect(BUNNY_AGENT_ACTIONS).toEqual([
      'research',
      'draft',
      'review',
      'schedule',
      'report',
      'pause',
      'resume',
      'status',
    ]);

    expect(bunnyActionPayload('research')).toEqual({
      domain: 'bunny',
      bunny_action: 'research',
      bunny_skill: 'research_topics',
    });
    expect(bunnyActionPayload('report', { reportDate: '2026-06-24' })).toEqual({
      domain: 'bunny',
      bunny_action: 'report',
      bunny_skill: 'daily_report',
      reportDate: '2026-06-24',
    });
    expect(bunnyActionPayload('status')).toEqual({
      domain: 'bunny',
      bunny_action: 'status',
    });
  });

  it('renders a home card with explicit skill actions', () => {
    const status: BunnyStatus = {
      paused: false,
      livePublishing: false,
      queuedPosts: 2,
      dailyCreditBudget: 50,
    };
    const today: BunnyToday = { scheduled: [], drafts: [] };

    const card = bunnyHomeCard({ status, today });
    const text = JSON.stringify(card);

    expect(text).toContain('Bunny');
    expect(text).toContain('bunny_action');
    expect(text).toContain('research_topics');
    expect(text).toContain('generate_drafts');
    expect(text).toContain('review_queue');
    expect(text).toContain('schedule_posts');
    expect(text).toContain('daily_report');
    expect(text).toContain('pause_publishing');
    expect(text).toContain('resume_publishing');
    expect(text).not.toContain('/bunny');
    expect(text).not.toContain('__bridge_cb');
    expect(text).not.toContain('bridge_cb.v1');
    expect(collectButtonValues(card).map((value) => value.bunny_action)).toEqual(BUNNY_AGENT_ACTIONS);
  });
});

function collectButtonValues(card: unknown): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.tag === 'button' && record.value && typeof record.value === 'object') {
      values.push(record.value as Record<string, unknown>);
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else {
        visit(value);
      }
    }
  };
  visit(card);
  return values;
}
