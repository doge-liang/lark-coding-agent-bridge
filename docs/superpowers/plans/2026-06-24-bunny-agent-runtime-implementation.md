# Bunny Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Bunny from the superseded CLI/slash-command design into a repo-managed Andy-like agent with explicit business skills, hooks, and Feishu/Lark menu/card actions.

**Architecture:** Keep the useful Bunny domain modules already built under `src/bunny/` (types, config, store, scoring, generator, quality, scheduler, sources, X API, and engine). Remove user-facing CLI/server control surfaces. Add a focused `src/bunny/agent/` layer that owns Bunny's manifest, system prompt, skill registry, hook registry, skill dispatcher, and card payload builders; bridge integration should use card/menu/callback payloads, not `/bunny` commands.

**Tech Stack:** TypeScript ESM, Vitest, existing Bunny SQLite modules, existing CardKit-compatible card helpers, existing bridge callback conventions, existing profile path conventions.

---

## Scope Check

This plan implements the revised V1 surface from the confirmed spec:

- Bunny is a first-class agent package, not a bridge slash command.
- No `/bunny` command is registered in `src/commands/index.ts`.
- No user-facing `lark-channel-bridge bunny ...` CLI command group remains.
- Key business skills are explicit operations: `research_topics`, `generate_drafts`, `quality_check`, `review_queue`, `schedule_posts`, `pause_publishing`, `resume_publishing`, and `daily_report`.
- Natural language is allowed for low-risk advisory work only; state-changing actions go through explicit skill names, card actions, or hooks.

This plan does not implement a separate Lark bot identity, a full persistent Lark custom app menu, or live X metrics collection beyond the existing adapter foundation. If the current Lark app cannot expose a true floating menu, the V1 fallback is a Bunny home card with explicit buttons.

## File Structure

- Delete `src/bunny/server.ts`: superseded local HTTP control server.
- Delete `src/cli/commands/bunny.ts`: superseded user-facing CLI command group.
- Modify `src/cli/index.ts`: remove the `bunny` command registration.
- Modify `tests/unit/cli/index-registration.test.ts`: remove Bunny CLI registration assertions.
- Delete `tests/unit/bunny/server.test.ts` and `tests/unit/cli/bunny-command.test.ts`: tests for superseded surfaces.
- Create `src/bunny/agent/manifest.ts`: Bunny agent metadata, system prompt, skill names, skill definitions, and hook definitions.
- Create `src/bunny/agent/runtime.ts`: explicit skill dispatcher around `BunnyEngine` and `BunnyStore`.
- Create `src/bunny/agent/cards.ts`: Bunny home/review/report card builders using explicit `bunny_action` payloads.
- Create `src/bunny/agent/hooks.ts`: deterministic hook registry and hook runner.
- Create `src/bunny/reporter.ts`: daily report formatter used by runtime and hooks.
- Test `tests/unit/bunny/agent-manifest.test.ts`.
- Test `tests/unit/bunny/agent-runtime.test.ts`.
- Test `tests/unit/bunny/agent-cards.test.ts`.
- Test `tests/unit/bunny/hooks.test.ts`.
- Test `tests/unit/bunny/reporter.test.ts`.
- Modify `README.md`, `README.zh.md`, and `tests/unit/docs/readme-contract.test.ts`: document Bunny as an agent package with explicit skills and card/menu controls.

---

### Task 1: Remove Superseded CLI And HTTP Control Surfaces

**Files:**
- Delete: `src/bunny/server.ts`
- Delete: `src/cli/commands/bunny.ts`
- Delete: `tests/unit/bunny/server.test.ts`
- Delete: `tests/unit/cli/bunny-command.test.ts`
- Modify: `src/cli/index.ts`
- Modify: `tests/unit/cli/index-registration.test.ts`

- [ ] **Step 1: Write the failing cleanup expectation**

Modify `tests/unit/cli/index-registration.test.ts` so it asserts the CLI source does not register the Bunny command group:

```ts
expect(help).not.toContain("command('bunny')");
expect(help).not.toContain('Run and inspect the Bunny AI tools media agent');
```

Keep the existing positive assertions for supported CLI commands.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm test tests/unit/cli/index-registration.test.ts
```

Expected: FAIL because `src/cli/index.ts` still contains the superseded `bunny` command group.

- [ ] **Step 3: Remove the CLI command registration**

Edit `src/cli/index.ts`:

- remove the import from `./commands/bunny`
- remove the `const bunny = program.command('bunny')...` block
- remove the local `parsePort()` helper if nothing else uses it

Do not touch unrelated CLI commands.

- [ ] **Step 4: Delete superseded files**

Run:

```bash
rm src/bunny/server.ts src/cli/commands/bunny.ts tests/unit/bunny/server.test.ts tests/unit/cli/bunny-command.test.ts
```

Expected: the files are removed from the worktree.

- [ ] **Step 5: Run cleanup tests**

Run:

```bash
pnpm test tests/unit/cli/index-registration.test.ts tests/unit/bunny/engine.test.ts
pnpm typecheck
```

Expected: PASS after updating any import references that pointed to deleted files. `BunnyEngine` must remain because it is still the business orchestration layer.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/cli/index.ts tests/unit/cli/index-registration.test.ts
git rm src/bunny/server.ts src/cli/commands/bunny.ts tests/unit/bunny/server.test.ts tests/unit/cli/bunny-command.test.ts
git commit -m "refactor: remove bunny cli control surface"
```

---

### Task 2: Add Repo-Managed Bunny Agent Manifest And Prompt

**Files:**
- Create: `src/bunny/agent/manifest.ts`
- Test: `tests/unit/bunny/agent-manifest.test.ts`

- [ ] **Step 1: Write failing manifest tests**

Create `tests/unit/bunny/agent-manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BUNNY_AGENT_MANIFEST,
  BUNNY_SKILL_DEFINITIONS,
  BUNNY_SYSTEM_PROMPT,
  type BunnySkillName,
} from '../../../src/bunny/agent/manifest';

describe('Bunny agent manifest', () => {
  it('defines Bunny as an explicit agent package', () => {
    expect(BUNNY_AGENT_MANIFEST.id).toBe('bunny');
    expect(BUNNY_AGENT_MANIFEST.displayName).toBe('Bunny');
    expect(BUNNY_SYSTEM_PROMPT).toContain('AI tools media operator');
    expect(BUNNY_SYSTEM_PROMPT).toContain('Do not publish from vague natural language');
  });

  it('registers every V1 business skill with explicit trigger semantics', () => {
    const names = new Set(BUNNY_SKILL_DEFINITIONS.map((skill) => skill.name));
    const expected: BunnySkillName[] = [
      'research_topics',
      'generate_drafts',
      'quality_check',
      'review_queue',
      'schedule_posts',
      'pause_publishing',
      'resume_publishing',
      'daily_report',
    ];
    expect(names).toEqual(new Set(expected));
    expect(BUNNY_SKILL_DEFINITIONS.every((skill) => skill.trigger === 'explicit')).toBe(true);
  });

  it('does not expose slash or CLI commands as skills', () => {
    const text = JSON.stringify(BUNNY_AGENT_MANIFEST);
    expect(text).not.toContain('/bunny');
    expect(text).not.toContain('lark-channel-bridge bunny');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test tests/unit/bunny/agent-manifest.test.ts
```

Expected: FAIL because `src/bunny/agent/manifest.ts` does not exist.

- [ ] **Step 3: Implement manifest and prompt**

Create `src/bunny/agent/manifest.ts`:

```ts
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
  | 'scheduled_ingestion'
  | 'after_ingestion'
  | 'before_draft_generation'
  | 'after_draft_generation'
  | 'before_publish'
  | 'after_publish'
  | 'daily_report';

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
  { name: 'scheduled_ingestion', description: 'Collect fresh candidates.' },
  { name: 'after_ingestion', description: 'Score and store candidates.' },
  { name: 'before_draft_generation', description: 'Choose topics under budget.' },
  { name: 'after_draft_generation', description: 'Quality-check drafts.' },
  { name: 'before_publish', description: 'Enforce pause, live-mode, cadence, and approval gates.' },
  { name: 'after_publish', description: 'Record publish result and metrics intent.' },
  { name: 'daily_report', description: 'Send the daily Feishu/Lark summary.' },
];

export const BUNNY_AGENT_MANIFEST: BunnyAgentManifest = {
  id: 'bunny',
  displayName: 'Bunny',
  domain: 'ai-tools-media',
  promptVersion: 1,
  skills: BUNNY_SKILL_DEFINITIONS,
  hooks: BUNNY_HOOK_DEFINITIONS,
};
```

- [ ] **Step 4: Run manifest tests**

Run:

```bash
pnpm test tests/unit/bunny/agent-manifest.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/bunny/agent/manifest.ts tests/unit/bunny/agent-manifest.test.ts
git commit -m "feat: add bunny agent manifest"
```

---

### Task 3: Add Bunny Daily Reporter

**Files:**
- Create: `src/bunny/reporter.ts`
- Test: `tests/unit/bunny/reporter.test.ts`

- [ ] **Step 1: Write failing reporter tests**

Create `tests/unit/bunny/reporter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildDailyReport } from '../../../src/bunny/reporter';
import type { BunnyStatus, BunnyToday } from '../../../src/bunny/types';

describe('Bunny reporter', () => {
  it('summarizes mode, queue, scheduled posts, latest drafts, and metrics', () => {
    const status: BunnyStatus = {
      paused: false,
      livePublishing: false,
      queuedPosts: 1,
      dailyCreditBudget: 50,
    };
    const today: BunnyToday = {
      scheduled: [
        {
          id: 'sched-1',
          draftId: 'draft-1',
          postKey: 'post-key-1',
          publishAt: '2026-06-24T12:00:00.000Z',
          status: 'published',
          xPostId: '123',
          xPostUrl: 'https://x.com/i/web/status/123',
        },
      ],
      drafts: [
        {
          id: 'draft-1',
          topicId: 'topic-1',
          kind: 'single',
          chineseNote: '中文理解: Browser agent workflow',
          englishText: 'AI workflow worth studying: Browser agent workflow',
          sourceUrl: 'https://example.test/browser-agent',
          status: 'draft',
          createdAt: '2026-06-24T10:00:00.000Z',
        },
      ],
    };
    const report = buildDailyReport(today, status, new Map([
      ['post-key-1', [{ impressions: 100, likes: 8, reposts: 2, replies: 1 }]],
    ]));

    expect(report).toContain('Bunny Daily Report');
    expect(report).toContain('dry-run');
    expect(report).toContain('post-key-1');
    expect(report).toContain('100 impressions');
    expect(report).toContain('Browser agent workflow');
  });
});
```

- [ ] **Step 2: Run reporter tests to verify they fail**

Run:

```bash
pnpm test tests/unit/bunny/reporter.test.ts
```

Expected: FAIL because `src/bunny/reporter.ts` does not exist.

- [ ] **Step 3: Implement reporter**

Create `src/bunny/reporter.ts`:

```ts
import type { BunnyStatus, BunnyToday } from './types';

export interface BunnyMetricSummary {
  impressions: number;
  likes: number;
  reposts: number;
  replies: number;
}

export function buildDailyReport(
  today: BunnyToday,
  status: BunnyStatus,
  metricsByPostKey: Map<string, BunnyMetricSummary[]>,
): string {
  const mode = status.livePublishing ? 'live' : 'dry-run';
  const scheduled = today.scheduled.length
    ? today.scheduled.map((post) => {
        const metric = metricsByPostKey.get(post.postKey)?.[0];
        const metricText = metric
          ? ` - ${metric.impressions} impressions, ${metric.likes} likes, ${metric.reposts} reposts, ${metric.replies} replies`
          : '';
        return `- ${post.publishAt} ${post.status} \`${post.postKey}\`${metricText}`;
      })
    : ['- No scheduled posts for today'];
  const drafts = today.drafts.length
    ? today.drafts.slice(0, 5).map((draft) => `- ${firstLine(draft.englishText)} (${draft.sourceUrl})`)
    : ['- No drafts generated yet'];

  return [
    '**Bunny Daily Report**',
    `Mode: ${mode}`,
    `State: ${status.paused ? 'paused' : 'running'}`,
    `Queue: ${status.queuedPosts}`,
    `Daily budget: ${status.dailyCreditBudget} credits`,
    '',
    '**Scheduled**',
    ...scheduled,
    '',
    '**Latest Drafts**',
    ...drafts,
  ].join('\n');
}

function firstLine(value: string): string {
  return value.split('\n')[0]?.trim() || value.trim();
}
```

- [ ] **Step 4: Run reporter tests**

Run:

```bash
pnpm test tests/unit/bunny/reporter.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/bunny/reporter.ts tests/unit/bunny/reporter.test.ts
git commit -m "feat: add bunny daily reporter"
```

---

### Task 4: Add Explicit Bunny Skill Runtime

**Files:**
- Create: `src/bunny/agent/runtime.ts`
- Test: `tests/unit/bunny/agent-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Create `tests/unit/bunny/agent-runtime.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BunnyAgentRuntime } from '../../../src/bunny/agent/runtime';
import { BunnyEngine } from '../../../src/bunny/engine';
import { BunnyStore } from '../../../src/bunny/store';
import { manualCandidate } from '../../../src/bunny/sources';

const roots: string[] = [];

describe('BunnyAgentRuntime', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('dispatches explicit research and review skills', async () => {
    const store = await createStore();
    store.upsertCandidate(manualCandidate({
      title: 'Browser agent workflow',
      url: 'https://example.test/browser-agent',
      summary: 'Step-by-step AI workflow for research automation.',
      nowIso: '2026-06-24T09:00:00.000Z',
    }));
    const runtime = new BunnyAgentRuntime({ engine: new BunnyEngine({ store }), store });

    const research = await runtime.dispatch({ skill: 'research_topics', nowIso: '2026-06-24T10:00:00.000Z' });
    expect(research.ok).toBe(true);
    expect(research.markdown).toContain('generated');

    const queue = await runtime.dispatch({ skill: 'review_queue', nowIso: '2026-06-24T10:00:00.000Z' });
    expect(queue.ok).toBe(true);
    expect(queue.markdown).toContain('Review Queue');
  });

  it('requires confirmation for scheduling and resume actions', async () => {
    const store = await createStore();
    const runtime = new BunnyAgentRuntime({ engine: new BunnyEngine({ store }), store });

    await expect(runtime.dispatch({ skill: 'schedule_posts' })).resolves.toMatchObject({
      ok: false,
      requiresConfirmation: true,
    });
    await expect(runtime.dispatch({ skill: 'resume_publishing' })).resolves.toMatchObject({
      ok: false,
      requiresConfirmation: true,
    });
  });

  it('pauses publishing through an explicit skill', async () => {
    const store = await createStore();
    const runtime = new BunnyAgentRuntime({ engine: new BunnyEngine({ store }), store });

    const result = await runtime.dispatch({ skill: 'pause_publishing' });

    expect(result.ok).toBe(true);
    expect(store.getSettings().paused).toBe(true);
    expect(result.markdown).toContain('paused');
  });
});

async function createStore(): Promise<BunnyStore> {
  const root = await mkdtemp(join(tmpdir(), 'bunny-agent-runtime-'));
  roots.push(root);
  return new BunnyStore(join(root, 'bunny.sqlite'));
}
```

- [ ] **Step 2: Run runtime tests to verify they fail**

Run:

```bash
pnpm test tests/unit/bunny/agent-runtime.test.ts
```

Expected: FAIL because `src/bunny/agent/runtime.ts` does not exist.

- [ ] **Step 3: Implement runtime dispatcher**

Create `src/bunny/agent/runtime.ts`:

```ts
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
```

- [ ] **Step 4: Run runtime tests**

Run:

```bash
pnpm test tests/unit/bunny/agent-runtime.test.ts tests/unit/bunny/engine.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/bunny/agent/runtime.ts tests/unit/bunny/agent-runtime.test.ts
git commit -m "feat: add bunny skill runtime"
```

---

### Task 5: Add Bunny Home And Review Cards

**Files:**
- Create: `src/bunny/agent/cards.ts`
- Test: `tests/unit/bunny/agent-cards.test.ts`

- [ ] **Step 1: Write failing card tests**

Create `tests/unit/bunny/agent-cards.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bunnyHomeCard } from '../../../src/bunny/agent/cards';
import type { BunnyStatus, BunnyToday } from '../../../src/bunny/types';

describe('Bunny agent cards', () => {
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
    expect(text).toContain('review_queue');
    expect(text).toContain('pause_publishing');
    expect(text).not.toContain('/bunny');
  });
});
```

- [ ] **Step 2: Run card tests to verify they fail**

Run:

```bash
pnpm test tests/unit/bunny/agent-cards.test.ts
```

Expected: FAIL because `src/bunny/agent/cards.ts` does not exist.

- [ ] **Step 3: Implement card builders**

Create `src/bunny/agent/cards.ts`:

```ts
import type { BunnySkillName } from './manifest';
import type { BunnyStatus, BunnyToday } from '../types';

export interface BunnyHomeCardOptions {
  status: BunnyStatus;
  today: BunnyToday;
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
          actionButton('Research', 'research_topics', 'primary'),
          actionButton('Review Queue', 'review_queue'),
          actionButton('Daily Report', 'daily_report'),
        ],
      },
      {
        tag: 'action',
        actions: [
          actionButton('Pause', 'pause_publishing', 'danger'),
          actionButton('Resume', 'resume_publishing'),
        ],
      },
    ],
  };
}

function actionButton(
  text: string,
  action: BunnySkillName,
  style: 'primary' | 'danger' | 'default' = 'default',
): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type: style,
    value: { bunny_action: action },
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}
```

- [ ] **Step 4: Run card tests**

Run:

```bash
pnpm test tests/unit/bunny/agent-cards.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/bunny/agent/cards.ts tests/unit/bunny/agent-cards.test.ts
git commit -m "feat: add bunny agent cards"
```

---

### Task 6: Add Bunny Hook Registry

**Files:**
- Create: `src/bunny/agent/hooks.ts`
- Test: `tests/unit/bunny/hooks.test.ts`

- [ ] **Step 1: Write failing hook tests**

Create `tests/unit/bunny/hooks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createBunnyHookRunner } from '../../../src/bunny/agent/hooks';

describe('Bunny hook runner', () => {
  it('runs registered hooks in deterministic order', async () => {
    const calls: string[] = [];
    const runner = createBunnyHookRunner([
      { name: 'after_ingestion', run: async () => { calls.push('first'); } },
      { name: 'after_ingestion', run: async () => { calls.push('second'); } },
    ]);

    await runner.run('after_ingestion', { nowIso: '2026-06-24T00:00:00.000Z' });

    expect(calls).toEqual(['first', 'second']);
  });

  it('rejects unknown hook names at registration time', () => {
    expect(() =>
      createBunnyHookRunner([
        { name: 'not_a_hook' as never, run: async () => {} },
      ]),
    ).toThrow(/unknown Bunny hook/);
  });
});
```

- [ ] **Step 2: Run hook tests to verify they fail**

Run:

```bash
pnpm test tests/unit/bunny/hooks.test.ts
```

Expected: FAIL because `src/bunny/agent/hooks.ts` does not exist.

- [ ] **Step 3: Implement hook registry**

Create `src/bunny/agent/hooks.ts`:

```ts
import { BUNNY_HOOK_DEFINITIONS, type BunnyHookName } from './manifest';

export interface BunnyHookContext {
  nowIso: string;
}

export interface BunnyHook {
  name: BunnyHookName;
  run(context: BunnyHookContext): Promise<void>;
}

export interface BunnyHookRunner {
  run(name: BunnyHookName, context: BunnyHookContext): Promise<void>;
}

const KNOWN_HOOKS = new Set(BUNNY_HOOK_DEFINITIONS.map((hook) => hook.name));

export function createBunnyHookRunner(hooks: BunnyHook[]): BunnyHookRunner {
  for (const hook of hooks) {
    if (!KNOWN_HOOKS.has(hook.name)) {
      throw new Error(`unknown Bunny hook: ${String(hook.name)}`);
    }
  }
  return {
    async run(name, context) {
      for (const hook of hooks) {
        if (hook.name === name) await hook.run(context);
      }
    },
  };
}
```

- [ ] **Step 4: Run hook tests**

Run:

```bash
pnpm test tests/unit/bunny/hooks.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/bunny/agent/hooks.ts tests/unit/bunny/hooks.test.ts
git commit -m "feat: add bunny hook runner"
```

---

### Task 7: Document Bunny Agent Operation

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `tests/unit/docs/readme-contract.test.ts`

- [ ] **Step 1: Write failing README contract expectations**

Modify `tests/unit/docs/readme-contract.test.ts` so combined README text must mention the new Bunny shape:

```ts
expect(docs).toContain('Bunny AI tools media agent');
expect(docs).toContain('Bunny AI 工具自媒体 agent');
expect(docs).toContain('explicit business skills');
expect(docs).toContain('显式业务 skill');
expect(docs).toContain('Feishu/Lark menu');
expect(docs).not.toContain('/bunny status');
expect(docs).not.toContain('lark-channel-bridge bunny serve');
```

- [ ] **Step 2: Run README contract to verify it fails**

Run:

```bash
pnpm test tests/unit/docs/readme-contract.test.ts
```

Expected: FAIL because the READMEs do not yet document Bunny as an agent package.

- [ ] **Step 3: Update English README**

Add a short section to `README.md` near the command/operation documentation:

```md
### Bunny AI tools media agent

Bunny is an optional repo-managed agent package for AI tools X/Twitter content
operations. It is not exposed as a `/bunny` slash command or a user-facing CLI
command group.

Bunny uses:

- a Bunny-specific system prompt
- explicit business skills for research, draft generation, review, scheduling,
  pause/resume, and daily reports
- hooks for scheduled ingestion, draft checks, publishing gates, and reporting
- Feishu/Lark menu or card actions for state-changing operations

Natural-language chat is reserved for low-risk advisory work. Publishing,
scheduling, pausing, and resuming require explicit business skills or signed
card callbacks.
```

- [ ] **Step 4: Update Chinese README**

Add the Chinese equivalent to `README.zh.md`:

```md
### Bunny AI 工具自媒体 agent

Bunny 是可选的、由 git repo 管理的 AI 工具方向 X/Twitter 自媒体 agent。
它不是 `/bunny` slash command，也不是用户侧 CLI 命令组。

Bunny 使用：

- 独立的 Bunny system prompt
- 显式业务 skill：选题、生成草稿、审核、排期、暂停/恢复、日报
- hooks：定时采集、草稿检查、发布前门禁、发布后记录、日报
- 飞书菜单或卡片动作来触发有状态业务操作

自然语言只用于低风险咨询和改稿。发布、排期、暂停和恢复必须通过显式
业务 skill 或签名卡片回调触发。
```

- [ ] **Step 5: Run docs tests**

Run:

```bash
pnpm test tests/unit/docs/readme-contract.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add README.md README.zh.md tests/unit/docs/readme-contract.test.ts
git commit -m "docs: document bunny agent runtime"
```

---

### Task 8: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused Bunny tests**

Run:

```bash
pnpm test tests/unit/bunny/config.test.ts tests/unit/bunny/store.test.ts tests/unit/bunny/pipeline.test.ts tests/unit/bunny/sources.test.ts tests/unit/bunny/x-api.test.ts tests/unit/bunny/engine.test.ts tests/unit/bunny/agent-manifest.test.ts tests/unit/bunny/agent-runtime.test.ts tests/unit/bunny/agent-cards.test.ts tests/unit/bunny/hooks.test.ts tests/unit/bunny/reporter.test.ts
```

Expected: all listed Bunny tests pass.

- [ ] **Step 2: Run full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: all three commands exit 0.

- [ ] **Step 3: Inspect for superseded surfaces**

Run:

```bash
rg -n "/bunny|lark-channel-bridge bunny|command\\('bunny'\\)|src/cli/commands/bunny|src/bunny/server" src tests README.md README.zh.md
```

Expected: no matches except historical docs explicitly marked as superseded under `docs/superpowers/plans/2026-06-23-bunny-twitter-agent-implementation.md`, which is outside this command's path set.

- [ ] **Step 4: Commit verification note if needed**

If verification required a documentation or test fix, commit it:

```bash
git add <fixed-files>
git commit -m "test: verify bunny agent runtime"
```

If no files changed, do not create an empty commit.

---

## Final Handoff Checklist

- [ ] There is no `/bunny` command registered in `src/commands/index.ts`.
- [ ] There is no user-facing `bunny` CLI command group in `src/cli/index.ts`.
- [ ] Bunny has a repo-managed system prompt and manifest.
- [ ] Bunny business skills are explicit and typed.
- [ ] State-changing skills require explicit dispatch; resume and schedule require confirmation.
- [ ] Bunny home cards expose `bunny_action` payloads, not slash commands.
- [ ] Bunny hooks are registered through a deterministic hook runner.
- [ ] Existing Bunny store, scoring, generation, quality, scheduler, sources, engine, and X adapter tests still pass.
- [ ] Full verification passes: `pnpm test`, `pnpm typecheck`, `pnpm build`.
