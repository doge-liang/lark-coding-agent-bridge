import type { BunnyStatus, BunnyToday } from '../types';
import type { BunnySkillName } from './manifest';

export type BunnyAgentAction =
  | 'research'
  | 'draft'
  | 'review'
  | 'schedule'
  | 'report'
  | 'pause'
  | 'resume'
  | 'status';

export const BUNNY_AGENT_ACTIONS: BunnyAgentAction[] = [
  'research',
  'draft',
  'review',
  'schedule',
  'report',
  'pause',
  'resume',
  'status',
];

const ACTION_SKILLS: Partial<Record<BunnyAgentAction, BunnySkillName>> = {
  research: 'research_topics',
  draft: 'generate_drafts',
  review: 'review_queue',
  schedule: 'schedule_posts',
  report: 'daily_report',
  pause: 'pause_publishing',
  resume: 'resume_publishing',
};

export function isBunnyAgentAction(action: unknown): action is BunnyAgentAction {
  return typeof action === 'string' && BUNNY_AGENT_ACTIONS.includes(action as BunnyAgentAction);
}

export function bunnySkillForAction(action: BunnyAgentAction): BunnySkillName | undefined {
  return ACTION_SKILLS[action];
}

export interface BunnyHomeCardOptions {
  status: BunnyStatus;
  today: BunnyToday;
}

export function bunnyActionPayload(
  action: BunnyAgentAction,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const skill = ACTION_SKILLS[action];
  return {
    domain: 'bunny',
    bunny_action: action,
    ...(skill ? { bunny_skill: skill } : {}),
    ...extra,
  };
}

export function bunnyHomeCard(options: BunnyHomeCardOptions): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: 'Bunny' } },
    elements: [
      divMd([
        `**State:** ${options.status.paused ? 'paused' : 'running'}`,
        `**Mode:** ${options.status.livePublishing ? 'live' : 'dry-run'}`,
        `**Queue:** ${options.status.queuedPosts}`,
        `**Today:** ${options.today.scheduled.length} scheduled, ${options.today.drafts.length} drafts`,
      ].join('\n')),
      {
        tag: 'action',
        actions: [
          actionButton('Research', 'research', 'primary'),
          actionButton('Draft', 'draft'),
          actionButton('Review Queue', 'review'),
          actionButton('Schedule', 'schedule'),
        ],
      },
      {
        tag: 'action',
        actions: [
          actionButton('Daily Report', 'report'),
          actionButton('Pause', 'pause', 'danger'),
          actionButton('Resume', 'resume'),
          actionButton('Status', 'status'),
        ],
      },
    ],
  };
}

function actionButton(
  text: string,
  action: BunnyAgentAction,
  style: 'primary' | 'danger' | 'default' = 'default',
): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type: style,
    value: bunnyActionPayload(action),
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}
