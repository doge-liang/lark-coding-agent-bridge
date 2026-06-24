export type BunnySkillName =
  | 'research_topics'
  | 'generate_drafts'
  | 'quality_check'
  | 'review_queue'
  | 'schedule_posts'
  | 'pause_publishing'
  | 'resume_publishing'
  | 'daily_report';

export type BunnyHookName =
  | 'before_research'
  | 'after_research'
  | 'before_draft'
  | 'after_draft'
  | 'before_schedule'
  | 'after_schedule'
  | 'before_publish'
  | 'after_publish'
  | 'before_report'
  | 'after_report';

export interface BunnySkillDefinition {
  name: BunnySkillName;
  label: string;
  description: string;
  trigger: 'explicit';
  mutatesState: boolean;
  requiresConfirmation: boolean;
}

export interface BunnyHookDefinition {
  name: BunnyHookName;
  description: string;
}

export interface BunnyAgentManifest {
  id: 'bunny';
  displayName: 'Bunny';
  domain: 'ai-tools-media';
  promptVersion: number;
  skills: BunnySkillDefinition[];
  hooks: BunnyHookDefinition[];
}

export const BUNNY_SYSTEM_PROMPT = `You are Bunny, an AI tools media operator for X/Twitter.

Focus on AI tools, AI workflow tutorials, English-first posts, and concise Chinese research notes for the owner.

Low-risk advisory conversation is allowed. State-changing business actions must use explicit Bunny skills, menu items, card callbacks, or unambiguous typed skill names.

Do not publish from vague natural language. Do not schedule, pause, resume, or enable live publishing unless an explicit skill action or signed callback requested it.

Avoid engagement farming, unsupported income promises, fake scarcity, and unsupported product capability claims. Keep source attribution visible for tool reviews.`;

export const BUNNY_SKILL_DEFINITIONS: BunnySkillDefinition[] = [
  {
    name: 'research_topics',
    label: 'Research topics',
    description: 'Collect and score AI tool/workflow candidates.',
    trigger: 'explicit',
    mutatesState: true,
    requiresConfirmation: false,
  },
  {
    name: 'generate_drafts',
    label: 'Generate drafts',
    description: 'Generate Chinese notes and English posts from selected topics.',
    trigger: 'explicit',
    mutatesState: true,
    requiresConfirmation: false,
  },
  {
    name: 'quality_check',
    label: 'Quality check',
    description: 'Run duplicate, source, claim, length, and cadence checks.',
    trigger: 'explicit',
    mutatesState: false,
    requiresConfirmation: false,
  },
  {
    name: 'review_queue',
    label: 'Review queue',
    description: 'Show drafts and scheduled posts awaiting operator review.',
    trigger: 'explicit',
    mutatesState: false,
    requiresConfirmation: false,
  },
  {
    name: 'schedule_posts',
    label: 'Schedule posts',
    description: 'Schedule approved drafts under Bunny cadence rules.',
    trigger: 'explicit',
    mutatesState: true,
    requiresConfirmation: true,
  },
  {
    name: 'pause_publishing',
    label: 'Pause publishing',
    description: 'Pause future publishing while keeping research and drafts available.',
    trigger: 'explicit',
    mutatesState: true,
    requiresConfirmation: false,
  },
  {
    name: 'resume_publishing',
    label: 'Resume publishing',
    description: 'Resume publishing after a deliberate operator action.',
    trigger: 'explicit',
    mutatesState: true,
    requiresConfirmation: true,
  },
  {
    name: 'daily_report',
    label: 'Daily report',
    description: 'Summarize posts, drafts, skipped items, metrics, and warnings.',
    trigger: 'explicit',
    mutatesState: false,
    requiresConfirmation: false,
  },
];

export const BUNNY_HOOK_DEFINITIONS: BunnyHookDefinition[] = [
  { name: 'before_research', description: 'Prepare sources and budget for topic research.' },
  { name: 'after_research', description: 'Record and score researched candidates.' },
  { name: 'before_draft', description: 'Choose topics under budget before draft generation.' },
  { name: 'after_draft', description: 'Quality-check generated drafts.' },
  { name: 'before_schedule', description: 'Enforce approval and cadence before scheduling.' },
  { name: 'after_schedule', description: 'Record schedule decisions.' },
  { name: 'before_publish', description: 'Enforce pause, live-mode, cadence, and approval gates.' },
  { name: 'after_publish', description: 'Record publish result and metrics intent.' },
  { name: 'before_report', description: 'Collect report context.' },
  { name: 'after_report', description: 'Record that the report was generated or sent.' },
];

export const BUNNY_AGENT_MANIFEST: BunnyAgentManifest = {
  id: 'bunny',
  displayName: 'Bunny',
  domain: 'ai-tools-media',
  promptVersion: 1,
  skills: BUNNY_SKILL_DEFINITIONS,
  hooks: BUNNY_HOOK_DEFINITIONS,
};
