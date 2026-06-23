# Bunny Twitter Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Bunny as an AI tools X/Twitter media agent with dry-run content operations, live X publishing behind explicit configuration, and a thin `/bunny` Feishu/Lark control surface.

**Architecture:** Add an isolated `src/bunny/` subsystem that owns configuration, SQLite persistence, ingestion, scoring, draft generation, quality checks, scheduling, X API access, a local HTTP control server, and bridge-facing command formatting. Wire only a narrow `/bunny` command into the existing bridge command handler. Keep bridge core free of topic, X, and content-generation business logic.

**Tech Stack:** TypeScript ESM, Node.js `http` and `fetch`, `better-sqlite3` for SQLite persistence, `rss-parser` for feed ingestion, Vitest, existing command/test helpers, existing profile path conventions.

---

## Scope Check

The approved spec covers one cohesive V1 slice: Bunny can operate independently and can be controlled from Feishu/Lark. The service, store, pipeline, X adapter, CLI, and `/bunny` bridge integration are separate units, but they are required for one working feature. This plan does not include automated replies, DMs, bulk follows, Web3 content, a web dashboard, or a generic social-platform abstraction.

## File Structure

- Create `src/bunny/types.ts`: shared Bunny domain types and status/result interfaces.
- Create `src/bunny/config.ts`: profile-local Bunny paths, environment parsing, and conservative defaults.
- Create `src/bunny/store.ts`: SQLite schema, migrations, and status-safe repository methods.
- Create `src/bunny/scoring.ts`: deterministic candidate scoring.
- Create `src/bunny/generator.ts`: template generator plus OpenAI-compatible HTTP provider interface.
- Create `src/bunny/quality.ts`: duplicate, source, cadence, and prohibited-claim checks.
- Create `src/bunny/scheduler.ts`: schedule generated drafts under V1 cadence and rollout rules.
- Create `src/bunny/sources.ts`: RSS/manual-source ingestion into candidates.
- Create `src/bunny/x-api.ts`: dry-run and live X API publish adapter.
- Create `src/bunny/engine.ts`: run-once pipeline orchestration and status assembly.
- Create `src/bunny/server.ts`: local HTTP control server for status, today, pause, resume, and run-once.
- Create `src/bunny/reporter.ts`: daily report formatting from scheduled posts, drafts, and metrics.
- Create `src/bunny/command-service.ts`: bridge-side client and user-facing markdown formatter.
- Create `src/cli/commands/bunny.ts`: CLI entrypoints for `bunny serve|run-once|status|pause|resume`.
- Modify `src/cli/index.ts`: register the `bunny` command group.
- Modify `src/commands/index.ts`: register `/bunny` and inject command handling like `/upgrade`.
- Modify `README.md` and `README.zh.md`: document Bunny V1, setup, dry-run, and commands.
- Add tests under `tests/unit/bunny/` and `tests/integration/commands/bunny-command.test.ts`.
- Modify `package.json` and `pnpm-lock.yaml`: add runtime dependencies `better-sqlite3` and `rss-parser`, plus dev dependency `@types/better-sqlite3`.

---

### Task 1: Bunny Config, Types, And Dependencies

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/bunny/types.ts`
- Create: `src/bunny/config.ts`
- Test: `tests/unit/bunny/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Create `tests/unit/bunny/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  defaultBunnySettings,
  loadBunnyConfigFromEnv,
  resolveBunnyPaths,
} from '../../../src/bunny/config';

describe('bunny config', () => {
  it('derives profile-local Bunny paths', () => {
    const appPaths = resolveAppPaths({ rootDir: '/tmp/lark-home', profile: 'codex-dev' });
    const paths = resolveBunnyPaths(appPaths);

    expect(paths.rootDir).toBe('/tmp/lark-home/profiles/codex-dev/bunny');
    expect(paths.dbFile).toBe('/tmp/lark-home/profiles/codex-dev/bunny/bunny.sqlite');
    expect(paths.logDir).toBe('/tmp/lark-home/profiles/codex-dev/bunny/logs');
  });

  it('uses conservative default settings', () => {
    expect(defaultBunnySettings()).toEqual({
      paused: false,
      livePublishing: false,
      dailyPostLimit: 2,
      threadCadenceDays: 3,
      firstLiveWeekDailyLimit: 1,
      dryRunDays: 3,
      dailyCreditBudget: 50,
      timezone: 'UTC',
    });
  });

  it('loads runtime config from explicit environment values', () => {
    const cfg = loadBunnyConfigFromEnv({
      BUNNY_BASE_URL: 'http://127.0.0.1:3827',
      BUNNY_X_BEARER_TOKEN: 'x-token',
      BUNNY_LLM_ENDPOINT: 'https://llm.example.test/v1/chat/completions',
      BUNNY_LLM_API_KEY: 'llm-key',
      BUNNY_LLM_MODEL: 'agent-model',
    });

    expect(cfg.baseUrl).toBe('http://127.0.0.1:3827');
    expect(cfg.xBearerToken).toBe('x-token');
    expect(cfg.llm).toEqual({
      endpoint: 'https://llm.example.test/v1/chat/completions',
      apiKey: 'llm-key',
      model: 'agent-model',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm test tests/unit/bunny/config.test.ts
```

Expected: FAIL because `src/bunny/config.ts` does not exist.

- [ ] **Step 3: Add dependencies**

Run:

```bash
pnpm add better-sqlite3 rss-parser
pnpm add -D @types/better-sqlite3
```

Expected: `package.json` and `pnpm-lock.yaml` include the new dependencies.

- [ ] **Step 4: Create shared Bunny types**

Create `src/bunny/types.ts`:

```ts
export type BunnyPostKind = 'single' | 'thread';
export type BunnyPostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'skipped';

export interface BunnySettings {
  paused: boolean;
  livePublishing: boolean;
  dailyPostLimit: number;
  threadCadenceDays: number;
  firstLiveWeekDailyLimit: number;
  dryRunDays: number;
  dailyCreditBudget: number;
  timezone: string;
}

export interface BunnyRuntimeConfig {
  baseUrl: string;
  xBearerToken?: string;
  llm?: {
    endpoint: string;
    apiKey: string;
    model: string;
  };
}

export interface BunnyCandidate {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  summary: string;
  discoveredAt: string;
}

export interface BunnyTopic {
  id: string;
  candidateId: string;
  title: string;
  url: string;
  summary: string;
  score: number;
  reason: string;
  createdAt: string;
}

export interface BunnyDraft {
  id: string;
  topicId: string;
  kind: BunnyPostKind;
  chineseNote: string;
  englishText: string;
  sourceUrl: string;
  status: BunnyPostStatus;
  qualityFailure?: string;
  createdAt: string;
}

export interface BunnyScheduledPost {
  id: string;
  draftId: string;
  postKey: string;
  publishAt: string;
  status: BunnyPostStatus;
  xPostId?: string;
  xPostUrl?: string;
  errorMessage?: string;
}

export interface BunnyStatus {
  paused: boolean;
  livePublishing: boolean;
  queuedPosts: number;
  lastPublishedAt?: string;
  lastError?: string;
  dailyCreditBudget: number;
}

export interface BunnyToday {
  scheduled: BunnyScheduledPost[];
  drafts: BunnyDraft[];
}
```

- [ ] **Step 5: Create config helpers**

Create `src/bunny/config.ts`:

```ts
import { join } from 'node:path';
import type { AppPaths } from '../config/app-paths';
import type { BunnyRuntimeConfig, BunnySettings } from './types';

export interface BunnyPaths {
  rootDir: string;
  dbFile: string;
  logDir: string;
}

export function resolveBunnyPaths(appPaths: Pick<AppPaths, 'profileDir'>): BunnyPaths {
  const rootDir = join(appPaths.profileDir, 'bunny');
  return {
    rootDir,
    dbFile: join(rootDir, 'bunny.sqlite'),
    logDir: join(rootDir, 'logs'),
  };
}

export function defaultBunnySettings(): BunnySettings {
  return {
    paused: false,
    livePublishing: false,
    dailyPostLimit: 2,
    threadCadenceDays: 3,
    firstLiveWeekDailyLimit: 1,
    dryRunDays: 3,
    dailyCreditBudget: 50,
    timezone: 'UTC',
  };
}

export function loadBunnyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BunnyRuntimeConfig {
  const baseUrl = nonEmpty(env.BUNNY_BASE_URL) ?? 'http://127.0.0.1:3827';
  const endpoint = nonEmpty(env.BUNNY_LLM_ENDPOINT);
  const apiKey = nonEmpty(env.BUNNY_LLM_API_KEY);
  const model = nonEmpty(env.BUNNY_LLM_MODEL);
  return {
    baseUrl,
    ...(nonEmpty(env.BUNNY_X_BEARER_TOKEN) ? { xBearerToken: nonEmpty(env.BUNNY_X_BEARER_TOKEN) } : {}),
    ...(endpoint && apiKey && model ? { llm: { endpoint, apiKey, model } } : {}),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
pnpm test tests/unit/bunny/config.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add package.json pnpm-lock.yaml src/bunny/types.ts src/bunny/config.ts tests/unit/bunny/config.test.ts
git commit -m "feat: add bunny config and types"
```

---

### Task 2: SQLite Store And Status Transitions

**Files:**
- Create: `src/bunny/store.ts`
- Test: `tests/unit/bunny/store.test.ts`

- [ ] **Step 1: Write failing store tests**

Create `tests/unit/bunny/store.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BunnyStore } from '../../../src/bunny/store';

const roots: string[] = [];

describe('BunnyStore', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('initializes settings and reports empty status', async () => {
    const store = await createStore();

    expect(store.getSettings()).toMatchObject({
      paused: false,
      livePublishing: false,
      dailyPostLimit: 2,
    });
    expect(store.status()).toMatchObject({
      paused: false,
      livePublishing: false,
      queuedPosts: 0,
      dailyCreditBudget: 50,
    });
  });

  it('upserts candidates, drafts, and scheduled posts without duplicates', async () => {
    const store = await createStore();

    store.upsertCandidate({
      id: 'cand-1',
      sourceId: 'manual',
      title: 'Agent browser automation',
      url: 'https://example.test/agent-browser',
      summary: 'A tool for browser-based AI workflows.',
      discoveredAt: '2026-06-23T00:00:00.000Z',
    });
    store.upsertCandidate({
      id: 'cand-1',
      sourceId: 'manual',
      title: 'Agent browser automation',
      url: 'https://example.test/agent-browser',
      summary: 'A tool for browser-based AI workflows.',
      discoveredAt: '2026-06-23T00:00:00.000Z',
    });

    expect(store.listCandidates()).toHaveLength(1);

    store.saveDraft({
      id: 'draft-1',
      topicId: 'topic-1',
      kind: 'single',
      chineseNote: '中文理解版',
      englishText: 'A useful AI workflow tool.',
      sourceUrl: 'https://example.test/agent-browser',
      status: 'draft',
      createdAt: '2026-06-23T00:01:00.000Z',
    });
    store.schedulePost({
      id: 'sched-1',
      draftId: 'draft-1',
      postKey: 'post-key-1',
      publishAt: '2026-06-23T12:00:00.000Z',
      status: 'scheduled',
    });

    expect(store.today('2026-06-23T00:00:00.000Z').scheduled).toHaveLength(1);
    expect(() =>
      store.schedulePost({
        id: 'sched-2',
        draftId: 'draft-1',
        postKey: 'post-key-1',
        publishAt: '2026-06-23T13:00:00.000Z',
        status: 'scheduled',
      }),
    ).not.toThrow();
    expect(store.today('2026-06-23T00:00:00.000Z').scheduled).toHaveLength(1);
  });

  it('persists topics and post metrics', async () => {
    const store = await createStore();
    store.saveTopic({
      id: 'topic-1',
      candidateId: 'cand-1',
      title: 'Browser agent workflow',
      url: 'https://example.test/browser-agent',
      summary: 'A workflow tutorial.',
      score: 91,
      reason: 'workflow,tutorial',
      createdAt: '2026-06-23T00:00:00.000Z',
    });
    store.recordMetric({
      postKey: 'post-key-1',
      impressions: 100,
      likes: 8,
      reposts: 2,
      replies: 1,
      capturedAt: '2026-06-23T13:00:00.000Z',
    });

    expect(store.listTopics()).toHaveLength(1);
    expect(store.listMetrics('post-key-1')).toEqual([
      {
        postKey: 'post-key-1',
        impressions: 100,
        likes: 8,
        reposts: 2,
        replies: 1,
        capturedAt: '2026-06-23T13:00:00.000Z',
      },
    ]);
  });

  it('pauses and resumes publishing state', async () => {
    const store = await createStore();

    store.setPaused(true);
    expect(store.status().paused).toBe(true);

    store.setPaused(false);
    expect(store.status().paused).toBe(false);
  });
});

async function createStore(): Promise<BunnyStore> {
  const root = await mkdtemp(join(tmpdir(), 'bunny-store-'));
  roots.push(root);
  return new BunnyStore(join(root, 'bunny.sqlite'));
}
```

- [ ] **Step 2: Run store tests to verify they fail**

Run:

```bash
pnpm test tests/unit/bunny/store.test.ts
```

Expected: FAIL because `BunnyStore` is not implemented.

- [ ] **Step 3: Implement `BunnyStore`**

Create `src/bunny/store.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { defaultBunnySettings } from './config';
import type {
  BunnyCandidate,
  BunnyDraft,
  BunnyScheduledPost,
  BunnySettings,
  BunnyStatus,
  BunnyToday,
  BunnyTopic,
} from './types';

type Row = Record<string, unknown>;

export class BunnyStore {
  private readonly db: Database.Database;

  constructor(dbFile: string) {
    mkdirSync(dirname(dbFile), { recursive: true });
    this.db = new Database(dbFile);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.ensureSettings();
  }

  close(): void {
    this.db.close();
  }

  getSettings(): BunnySettings {
    const row = this.db.prepare('select value from settings where key = ?').get('settings') as Row | undefined;
    return row ? JSON.parse(String(row.value)) as BunnySettings : defaultBunnySettings();
  }

  saveSettings(settings: BunnySettings): void {
    this.db.prepare('insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value')
      .run('settings', JSON.stringify(settings));
  }

  setPaused(paused: boolean): void {
    this.saveSettings({ ...this.getSettings(), paused });
    this.recordEvent('pause_state', paused ? 'paused' : 'resumed');
  }

  setLivePublishing(livePublishing: boolean): void {
    this.saveSettings({ ...this.getSettings(), livePublishing });
  }

  upsertCandidate(candidate: BunnyCandidate): void {
    this.db.prepare(`
      insert into candidates(id, source_id, title, url, summary, discovered_at)
      values(@id, @sourceId, @title, @url, @summary, @discoveredAt)
      on conflict(id) do update set
        source_id = excluded.source_id,
        title = excluded.title,
        url = excluded.url,
        summary = excluded.summary,
        discovered_at = excluded.discovered_at
    `).run(candidate);
  }

  listCandidates(): BunnyCandidate[] {
    return this.db.prepare('select * from candidates order by discovered_at desc')
      .all()
      .map(candidateFromRow);
  }

  saveTopic(topic: BunnyTopic): void {
    this.db.prepare(`
      insert into topics(id, candidate_id, title, url, summary, score, reason, created_at)
      values(@id, @candidateId, @title, @url, @summary, @score, @reason, @createdAt)
      on conflict(id) do update set
        candidate_id = excluded.candidate_id,
        title = excluded.title,
        url = excluded.url,
        summary = excluded.summary,
        score = excluded.score,
        reason = excluded.reason,
        created_at = excluded.created_at
    `).run(topic);
  }

  listTopics(): BunnyTopic[] {
    return this.db.prepare('select * from topics order by score desc, created_at desc').all().map(topicFromRow);
  }

  saveDraft(draft: BunnyDraft): void {
    this.db.prepare(`
      insert into drafts(id, topic_id, kind, chinese_note, english_text, source_url, status, quality_failure, created_at)
      values(@id, @topicId, @kind, @chineseNote, @englishText, @sourceUrl, @status, @qualityFailure, @createdAt)
      on conflict(id) do update set
        topic_id = excluded.topic_id,
        kind = excluded.kind,
        chinese_note = excluded.chinese_note,
        english_text = excluded.english_text,
        source_url = excluded.source_url,
        status = excluded.status,
        quality_failure = excluded.quality_failure,
        created_at = excluded.created_at
    `).run({ ...draft, qualityFailure: draft.qualityFailure ?? null });
  }

  listDrafts(): BunnyDraft[] {
    return this.db.prepare('select * from drafts order by created_at desc').all().map(draftFromRow);
  }

  schedulePost(post: BunnyScheduledPost): void {
    this.db.prepare(`
      insert into scheduled_posts(id, draft_id, post_key, publish_at, status, x_post_id, x_post_url, error_message)
      values(@id, @draftId, @postKey, @publishAt, @status, @xPostId, @xPostUrl, @errorMessage)
      on conflict(post_key) do update set
        draft_id = excluded.draft_id,
        publish_at = excluded.publish_at,
        status = excluded.status,
        x_post_id = excluded.x_post_id,
        x_post_url = excluded.x_post_url,
        error_message = excluded.error_message
    `).run({
      ...post,
      xPostId: post.xPostId ?? null,
      xPostUrl: post.xPostUrl ?? null,
      errorMessage: post.errorMessage ?? null,
    });
  }

  listScheduled(): BunnyScheduledPost[] {
    return this.db.prepare('select * from scheduled_posts order by publish_at asc').all().map(scheduledFromRow);
  }

  claimDuePosts(nowIso: string): BunnyScheduledPost[] {
    return this.db.prepare(`
      select * from scheduled_posts
      where status = 'scheduled' and publish_at <= ?
      order by publish_at asc
    `).all(nowIso).map(scheduledFromRow);
  }

  markPublished(postKey: string, xPostId: string, xPostUrl: string, nowIso: string): void {
    this.db.prepare(`
      update scheduled_posts
      set status = 'published', x_post_id = ?, x_post_url = ?, error_message = null
      where post_key = ?
    `).run(xPostId, xPostUrl, postKey);
    this.recordEvent('published', `${postKey} ${xPostId}`, nowIso);
  }

  markFailed(postKey: string, errorMessage: string): void {
    this.db.prepare(`
      update scheduled_posts
      set status = 'failed', error_message = ?
      where post_key = ?
    `).run(errorMessage, postKey);
    this.recordEvent('publish_failed', `${postKey} ${errorMessage}`);
  }

  recordMetric(input: {
    postKey: string;
    impressions: number;
    likes: number;
    reposts: number;
    replies: number;
    capturedAt: string;
  }): void {
    this.db.prepare(`
      insert into metrics(post_key, impressions, likes, reposts, replies, captured_at)
      values(@postKey, @impressions, @likes, @reposts, @replies, @capturedAt)
    `).run(input);
  }

  listMetrics(postKey: string): Array<{
    postKey: string;
    impressions: number;
    likes: number;
    reposts: number;
    replies: number;
    capturedAt: string;
  }> {
    return this.db.prepare('select * from metrics where post_key = ? order by captured_at desc')
      .all(postKey)
      .map((row: Row) => ({
        postKey: String(row.post_key),
        impressions: Number(row.impressions),
        likes: Number(row.likes),
        reposts: Number(row.reposts),
        replies: Number(row.replies),
        capturedAt: String(row.captured_at),
      }));
  }

  today(nowIso: string): BunnyToday {
    const day = nowIso.slice(0, 10);
    return {
      scheduled: this.db.prepare(`
        select * from scheduled_posts
        where substr(publish_at, 1, 10) = ?
        order by publish_at asc
      `).all(day).map(scheduledFromRow),
      drafts: this.listDrafts().slice(0, 10),
    };
  }

  status(): BunnyStatus {
    const settings = this.getSettings();
    const queued = this.db.prepare("select count(*) as count from scheduled_posts where status = 'scheduled'")
      .get() as { count: number };
    const lastPublished = this.db.prepare(`
      select publish_at from scheduled_posts where status = 'published' order by publish_at desc limit 1
    `).get() as { publish_at?: string } | undefined;
    const lastError = this.db.prepare(`
      select error_message from scheduled_posts where error_message is not null order by publish_at desc limit 1
    `).get() as { error_message?: string } | undefined;
    return {
      paused: settings.paused,
      livePublishing: settings.livePublishing,
      queuedPosts: queued.count,
      ...(lastPublished?.publish_at ? { lastPublishedAt: lastPublished.publish_at } : {}),
      ...(lastError?.error_message ? { lastError: lastError.error_message } : {}),
      dailyCreditBudget: settings.dailyCreditBudget,
    };
  }

  recordEvent(kind: string, message: string, at = new Date().toISOString()): void {
    this.db.prepare('insert into events(kind, message, created_at) values(?, ?, ?)').run(kind, message, at);
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists settings(
        key text primary key,
        value text not null
      );
      create table if not exists candidates(
        id text primary key,
        source_id text not null,
        title text not null,
        url text not null,
        summary text not null,
        discovered_at text not null
      );
      create table if not exists sources(
        id text primary key,
        label text not null,
        url text not null,
        enabled integer not null default 1
      );
      create table if not exists topics(
        id text primary key,
        candidate_id text not null,
        title text not null,
        url text not null,
        summary text not null,
        score integer not null,
        reason text not null,
        created_at text not null
      );
      create table if not exists drafts(
        id text primary key,
        topic_id text not null,
        kind text not null,
        chinese_note text not null,
        english_text text not null,
        source_url text not null,
        status text not null,
        quality_failure text,
        created_at text not null
      );
      create table if not exists scheduled_posts(
        id text primary key,
        draft_id text not null,
        post_key text not null unique,
        publish_at text not null,
        status text not null,
        x_post_id text,
        x_post_url text,
        error_message text
      );
      create table if not exists events(
        id integer primary key autoincrement,
        kind text not null,
        message text not null,
        created_at text not null
      );
      create table if not exists metrics(
        id integer primary key autoincrement,
        post_key text not null,
        impressions integer not null,
        likes integer not null,
        reposts integer not null,
        replies integer not null,
        captured_at text not null
      );
    `);
  }

  private ensureSettings(): void {
    if (!this.db.prepare('select key from settings where key = ?').get('settings')) {
      this.saveSettings(defaultBunnySettings());
    }
  }
}

function candidateFromRow(row: Row): BunnyCandidate {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    title: String(row.title),
    url: String(row.url),
    summary: String(row.summary),
    discoveredAt: String(row.discovered_at),
  };
}

function draftFromRow(row: Row): BunnyDraft {
  return {
    id: String(row.id),
    topicId: String(row.topic_id),
    kind: row.kind === 'thread' ? 'thread' : 'single',
    chineseNote: String(row.chinese_note),
    englishText: String(row.english_text),
    sourceUrl: String(row.source_url),
    status: String(row.status) as BunnyDraft['status'],
    ...(row.quality_failure ? { qualityFailure: String(row.quality_failure) } : {}),
    createdAt: String(row.created_at),
  };
}

function topicFromRow(row: Row): BunnyTopic {
  return {
    id: String(row.id),
    candidateId: String(row.candidate_id),
    title: String(row.title),
    url: String(row.url),
    summary: String(row.summary),
    score: Number(row.score),
    reason: String(row.reason),
    createdAt: String(row.created_at),
  };
}

function scheduledFromRow(row: Row): BunnyScheduledPost {
  return {
    id: String(row.id),
    draftId: String(row.draft_id),
    postKey: String(row.post_key),
    publishAt: String(row.publish_at),
    status: String(row.status) as BunnyScheduledPost['status'],
    ...(row.x_post_id ? { xPostId: String(row.x_post_id) } : {}),
    ...(row.x_post_url ? { xPostUrl: String(row.x_post_url) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
  };
}
```

- [ ] **Step 4: Run store tests to verify they pass**

Run:

```bash
pnpm test tests/unit/bunny/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/bunny/store.ts tests/unit/bunny/store.test.ts
git commit -m "feat: add bunny sqlite store"
```

---

### Task 3: Scoring, Generation, Quality, And Scheduling

**Files:**
- Create: `src/bunny/scoring.ts`
- Create: `src/bunny/generator.ts`
- Create: `src/bunny/quality.ts`
- Create: `src/bunny/scheduler.ts`
- Test: `tests/unit/bunny/pipeline.test.ts`

- [ ] **Step 1: Write failing pipeline tests**

Create `tests/unit/bunny/pipeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scoreCandidate } from '../../../src/bunny/scoring';
import { TemplateBunnyGenerator } from '../../../src/bunny/generator';
import { checkDraftQuality } from '../../../src/bunny/quality';
import { planSchedule } from '../../../src/bunny/scheduler';

describe('Bunny content pipeline', () => {
  it('scores workflow tutorials above generic announcements', () => {
    const scored = scoreCandidate({
      id: 'cand-1',
      sourceId: 'manual',
      title: 'Build a browser agent workflow for research',
      url: 'https://example.test/workflow',
      summary: 'Step-by-step automation workflow for AI research.',
      discoveredAt: '2026-06-23T00:00:00.000Z',
    }, new Set());

    expect(scored.score).toBeGreaterThanOrEqual(80);
    expect(scored.reason).toContain('workflow');
  });

  it('generates bilingual notes and English-first post text', async () => {
    const generator = new TemplateBunnyGenerator();
    const draft = await generator.generate({
      id: 'topic-1',
      candidateId: 'cand-1',
      title: 'Build a browser agent workflow for research',
      url: 'https://example.test/workflow',
      summary: 'Step-by-step automation workflow for AI research.',
      score: 91,
      reason: 'workflow tutorial',
      createdAt: '2026-06-23T00:00:00.000Z',
    }, '2026-06-23T00:01:00.000Z');

    expect(draft.chineseNote).toContain('中文理解');
    expect(draft.englishText).toContain('AI workflow');
    expect(draft.sourceUrl).toBe('https://example.test/workflow');
  });

  it('rejects unsupported earnings claims and accepts sourced workflow drafts', () => {
    expect(checkDraftQuality({
      id: 'draft-1',
      topicId: 'topic-1',
      kind: 'single',
      chineseNote: '中文理解版',
      englishText: 'This tool guarantees $10k/month with no work.',
      sourceUrl: 'https://example.test/workflow',
      status: 'draft',
      createdAt: '2026-06-23T00:01:00.000Z',
    }, new Set())).toEqual({ ok: false, reason: 'unsupported earnings claim' });

    expect(checkDraftQuality({
      id: 'draft-2',
      topicId: 'topic-1',
      kind: 'single',
      chineseNote: '中文理解版',
      englishText: 'A practical AI workflow for faster research: source, summarize, verify, publish.',
      sourceUrl: 'https://example.test/workflow',
      status: 'draft',
      createdAt: '2026-06-23T00:01:00.000Z',
    }, new Set())).toEqual({ ok: true });
  });

  it('schedules within conservative V1 cadence', () => {
    const schedule = planSchedule({
      draftIds: ['draft-1', 'draft-2', 'draft-3'],
      nowIso: '2026-06-23T08:00:00.000Z',
      dailyLimit: 2,
    });

    expect(schedule).toEqual([
      { draftId: 'draft-1', publishAt: '2026-06-23T12:00:00.000Z' },
      { draftId: 'draft-2', publishAt: '2026-06-23T18:00:00.000Z' },
    ]);
  });
});
```

- [ ] **Step 2: Run pipeline tests to verify they fail**

Run:

```bash
pnpm test tests/unit/bunny/pipeline.test.ts
```

Expected: FAIL because the pipeline modules do not exist.

- [ ] **Step 3: Implement scoring**

Create `src/bunny/scoring.ts`:

```ts
import { createHash } from 'node:crypto';
import type { BunnyCandidate, BunnyTopic } from './types';

export function scoreCandidate(candidate: BunnyCandidate, recentUrls: Set<string>, nowIso = new Date().toISOString()): BunnyTopic {
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
```

- [ ] **Step 4: Implement template generation**

Create `src/bunny/generator.ts`:

```ts
import { createHash } from 'node:crypto';
import type { BunnyDraft, BunnyTopic } from './types';

export interface BunnyGenerator {
  generate(topic: BunnyTopic, nowIso?: string): Promise<BunnyDraft>;
}

export class TemplateBunnyGenerator implements BunnyGenerator {
  async generate(topic: BunnyTopic, nowIso = new Date().toISOString()): Promise<BunnyDraft> {
    const id = `draft-${hash(`${topic.id}:${nowIso}`).slice(0, 12)}`;
    return {
      id,
      topicId: topic.id,
      kind: topic.summary.length > 180 ? 'thread' : 'single',
      chineseNote: `中文理解: ${topic.title}\n来源: ${topic.url}\n价值: ${topic.summary}`,
      englishText: [
        `AI workflow worth studying: ${topic.title}`,
        '',
        `Why it matters: ${topic.summary}`,
        '',
        `Source: ${topic.url}`,
      ].join('\n'),
      sourceUrl: topic.url,
      status: 'draft',
      createdAt: nowIso,
    };
  }
}

export class OpenAICompatibleBunnyGenerator implements BunnyGenerator {
  constructor(private readonly opts: { endpoint: string; apiKey: string; model: string }) {}

  async generate(topic: BunnyTopic, nowIso = new Date().toISOString()): Promise<BunnyDraft> {
    const response = await fetch(this.opts.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: [
          {
            role: 'system',
            content: 'Write concise, source-grounded AI tools Twitter content. Avoid unsupported earnings claims.',
          },
          {
            role: 'user',
            content: `Topic: ${topic.title}\nSummary: ${topic.summary}\nSource: ${topic.url}`,
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`);
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('LLM response had no message content');
    return {
      id: `draft-${hash(`${topic.id}:${nowIso}`).slice(0, 12)}`,
      topicId: topic.id,
      kind: content.length > 280 ? 'thread' : 'single',
      chineseNote: `中文理解: ${topic.title}\n来源: ${topic.url}\n价值: ${topic.summary}`,
      englishText: content,
      sourceUrl: topic.url,
      status: 'draft',
      createdAt: nowIso,
    };
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
```

- [ ] **Step 5: Implement quality checks**

Create `src/bunny/quality.ts`:

```ts
import { createHash } from 'node:crypto';
import type { BunnyDraft } from './types';

export type QualityResult = { ok: true; contentHash: string } | { ok: false; reason: string };

const EARNINGS_PATTERNS = [
  /\bguarantees?\b.+\$\d+/i,
  /\$\d+[kK]?\/month/i,
  /\bpassive income\b/i,
];

export function checkDraftQuality(draft: BunnyDraft, recentContentHashes: Set<string>): QualityResult {
  if (!draft.sourceUrl || !/^https?:\/\//.test(draft.sourceUrl)) return { ok: false, reason: 'missing source url' };
  if (draft.englishText.length < 40) return { ok: false, reason: 'post too short' };
  if (draft.englishText.length > 4000) return { ok: false, reason: 'post too long' };
  if (EARNINGS_PATTERNS.some((pattern) => pattern.test(draft.englishText))) {
    return { ok: false, reason: 'unsupported earnings claim' };
  }
  const contentHash = hash(`${draft.englishText}\n${draft.sourceUrl}`);
  if (recentContentHashes.has(contentHash)) return { ok: false, reason: 'duplicate content' };
  return { ok: true, contentHash };
}

export function postKeyForDraft(draft: BunnyDraft): string {
  return `bunny-${hash(`${draft.id}:${draft.sourceUrl}:${draft.englishText}`).slice(0, 16)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
```

- [ ] **Step 6: Implement scheduler**

Create `src/bunny/scheduler.ts`:

```ts
export interface PlanScheduleInput {
  draftIds: string[];
  nowIso: string;
  dailyLimit: number;
}

export interface PlannedSchedule {
  draftId: string;
  publishAt: string;
}

const UTC_SLOTS = [12, 18];

export function planSchedule(input: PlanScheduleInput): PlannedSchedule[] {
  const now = new Date(input.nowIso);
  const day = input.nowIso.slice(0, 10);
  return input.draftIds.slice(0, input.dailyLimit).map((draftId, index) => {
    const hour = UTC_SLOTS[index] ?? UTC_SLOTS.at(-1) ?? 18;
    const publishAt = new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);
    if (publishAt <= now) publishAt.setUTCDate(publishAt.getUTCDate() + 1);
    return { draftId, publishAt: publishAt.toISOString() };
  });
}
```

- [ ] **Step 7: Run pipeline tests to verify they pass**

Run:

```bash
pnpm test tests/unit/bunny/pipeline.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/bunny/scoring.ts src/bunny/generator.ts src/bunny/quality.ts src/bunny/scheduler.ts tests/unit/bunny/pipeline.test.ts
git commit -m "feat: add bunny content pipeline"
```

---

### Task 4: Source Ingestion

**Files:**
- Create: `src/bunny/sources.ts`
- Test: `tests/unit/bunny/sources.test.ts`

- [ ] **Step 1: Write failing ingestion tests**

Create `tests/unit/bunny/sources.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { candidatesFromFeedXml, manualCandidate } from '../../../src/bunny/sources';

describe('Bunny sources', () => {
  it('parses RSS feed items into candidates', async () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>AI Tools</title>
    <item>
      <title>Browser agent workflow</title>
      <link>https://example.test/browser-agent</link>
      <description>Automate research with a browser agent.</description>
      <pubDate>Tue, 23 Jun 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    const candidates = await candidatesFromFeedXml('feed-ai-tools', xml);

    expect(candidates).toEqual([
      {
        id: 'feed-ai-tools:66fa5fd39f1f',
        sourceId: 'feed-ai-tools',
        title: 'Browser agent workflow',
        url: 'https://example.test/browser-agent',
        summary: 'Automate research with a browser agent.',
        discoveredAt: '2026-06-23T10:00:00.000Z',
      },
    ]);
  });

  it('creates manual candidates from user-submitted links', () => {
    expect(manualCandidate({
      title: 'AI workflow checklist',
      url: 'https://example.test/checklist',
      summary: 'A checklist for evaluating AI tools.',
      nowIso: '2026-06-23T11:00:00.000Z',
    })).toMatchObject({
      sourceId: 'manual',
      title: 'AI workflow checklist',
      url: 'https://example.test/checklist',
    });
  });
});
```

- [ ] **Step 2: Run ingestion tests to verify they fail**

Run:

```bash
pnpm test tests/unit/bunny/sources.test.ts
```

Expected: FAIL because `src/bunny/sources.ts` does not exist.

- [ ] **Step 3: Implement source ingestion**

Create `src/bunny/sources.ts`:

```ts
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
    return [{
      id: `${sourceId}:${hash(url).slice(0, 12)}`,
      sourceId,
      title,
      url,
      summary: stripHtml(item.contentSnippet ?? item.content ?? item.summary ?? item.title ?? ''),
      discoveredAt,
    }];
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
  if (!response.ok) throw new Error(`feed fetch failed ${sourceId}: ${response.status}`);
  return candidatesFromFeedXml(sourceId, await response.text());
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function dateIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
```

- [ ] **Step 4: Run ingestion tests to verify they pass**

Run:

```bash
pnpm test tests/unit/bunny/sources.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/bunny/sources.ts tests/unit/bunny/sources.test.ts
git commit -m "feat: add bunny source ingestion"
```

---

### Task 5: X API Adapter With Dry-Run Guard

**Files:**
- Create: `src/bunny/x-api.ts`
- Test: `tests/unit/bunny/x-api.test.ts`

- [ ] **Step 1: Write failing X adapter tests**

Create `tests/unit/bunny/x-api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { XApiAdapter } from '../../../src/bunny/x-api';

describe('XApiAdapter', () => {
  it('returns dry-run result when live publishing is disabled', async () => {
    const adapter = new XApiAdapter({
      livePublishing: false,
      fetchImpl: vi.fn(),
    });

    await expect(adapter.publish({
      postKey: 'post-key',
      text: 'AI workflow post',
    })).resolves.toEqual({
      status: 'dry-run',
      postKey: 'post-key',
      message: 'live publishing disabled',
    });
  });

  it('posts to X API when live publishing is enabled', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { id: '12345' } }), { status: 201 }));
    const adapter = new XApiAdapter({
      livePublishing: true,
      bearerToken: 'token',
      fetchImpl,
    });

    await expect(adapter.publish({
      postKey: 'post-key',
      text: 'AI workflow post',
    })).resolves.toEqual({
      status: 'published',
      postKey: 'post-key',
      xPostId: '12345',
      xPostUrl: 'https://x.com/i/web/status/12345',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.x.com/2/tweets',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer token',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ text: 'AI workflow post' }),
      }),
    );
  });

  it('classifies API errors without leaking tokens', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limit', { status: 429 }));
    const adapter = new XApiAdapter({
      livePublishing: true,
      bearerToken: 'secret-token',
      fetchImpl,
    });

    await expect(adapter.publish({
      postKey: 'post-key',
      text: 'AI workflow post',
    })).resolves.toEqual({
      status: 'retryable-error',
      postKey: 'post-key',
      message: 'X API 429',
    });
  });
});
```

- [ ] **Step 2: Run X adapter tests to verify they fail**

Run:

```bash
pnpm test tests/unit/bunny/x-api.test.ts
```

Expected: FAIL because `XApiAdapter` is not implemented.

- [ ] **Step 3: Implement X API adapter**

Create `src/bunny/x-api.ts`:

```ts
export type XPublishResult =
  | { status: 'dry-run'; postKey: string; message: string }
  | { status: 'published'; postKey: string; xPostId: string; xPostUrl: string }
  | { status: 'retryable-error' | 'terminal-error'; postKey: string; message: string };

export interface XApiAdapterOptions {
  livePublishing: boolean;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
}

export interface XPublishInput {
  postKey: string;
  text: string;
}

export class XApiAdapter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: XApiAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async publish(input: XPublishInput): Promise<XPublishResult> {
    if (!this.options.livePublishing) {
      return { status: 'dry-run', postKey: input.postKey, message: 'live publishing disabled' };
    }
    if (!this.options.bearerToken) {
      return { status: 'terminal-error', postKey: input.postKey, message: 'missing X bearer token' };
    }
    const response = await this.fetchImpl('https://api.x.com/2/tweets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: input.text }),
    });
    if (!response.ok) {
      const status = response.status === 429 || response.status >= 500 ? 'retryable-error' : 'terminal-error';
      return { status, postKey: input.postKey, message: `X API ${response.status}` };
    }
    const json = await response.json() as { data?: { id?: string } };
    const xPostId = json.data?.id;
    if (!xPostId) return { status: 'terminal-error', postKey: input.postKey, message: 'X API response missing post id' };
    return {
      status: 'published',
      postKey: input.postKey,
      xPostId,
      xPostUrl: `https://x.com/i/web/status/${xPostId}`,
    };
  }
}
```

- [ ] **Step 4: Run X adapter tests to verify they pass**

Run:

```bash
pnpm test tests/unit/bunny/x-api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/bunny/x-api.ts tests/unit/bunny/x-api.test.ts
git commit -m "feat: add bunny x api adapter"
```

---

### Task 6: Engine, Local Server, And CLI

**Files:**
- Create: `src/bunny/engine.ts`
- Create: `src/bunny/server.ts`
- Create: `src/cli/commands/bunny.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/unit/bunny/engine.test.ts`
- Test: `tests/unit/bunny/server.test.ts`
- Test: `tests/unit/cli/index-registration.test.ts`

- [ ] **Step 1: Write failing engine tests**

Create `tests/unit/bunny/engine.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BunnyEngine } from '../../../src/bunny/engine';
import { BunnyStore } from '../../../src/bunny/store';
import { manualCandidate } from '../../../src/bunny/sources';

const roots: string[] = [];

describe('BunnyEngine', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('runs one dry-run pipeline and schedules posts', async () => {
    const store = await createStore();
    store.upsertCandidate(manualCandidate({
      title: 'Browser agent workflow',
      url: 'https://example.test/browser-agent',
      summary: 'Step-by-step AI workflow for research automation.',
      nowIso: '2026-06-23T09:00:00.000Z',
    }));
    const engine = new BunnyEngine({ store });

    const result = await engine.runOnce('2026-06-23T10:00:00.000Z');

    expect(result.generatedDrafts).toBe(1);
    expect(result.scheduledPosts).toBe(1);
    expect(store.status().queuedPosts).toBe(1);
  });

  it('does not publish while paused', async () => {
    const store = await createStore();
    store.setPaused(true);
    const engine = new BunnyEngine({ store });

    await expect(engine.publishDue('2026-06-23T12:00:00.000Z')).resolves.toEqual({
      published: 0,
      skipped: 'paused',
    });
  });
});

async function createStore(): Promise<BunnyStore> {
  const root = await mkdtemp(join(tmpdir(), 'bunny-engine-'));
  roots.push(root);
  return new BunnyStore(join(root, 'bunny.sqlite'));
}
```

- [ ] **Step 2: Write failing server tests**

Create `tests/unit/bunny/server.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BunnyEngine } from '../../../src/bunny/engine';
import { startBunnyServer } from '../../../src/bunny/server';
import { BunnyStore } from '../../../src/bunny/store';

const roots: string[] = [];

describe('Bunny local server', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('serves status and pause/resume controls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bunny-server-'));
    roots.push(root);
    const store = new BunnyStore(join(root, 'bunny.sqlite'));
    const server = await startBunnyServer({
      engine: new BunnyEngine({ store }),
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      expect(await json(`${base}/status`)).toMatchObject({ paused: false });

      await fetch(`${base}/pause`, { method: 'POST' });
      expect(await json(`${base}/status`)).toMatchObject({ paused: true });

      await fetch(`${base}/resume`, { method: 'POST' });
      expect(await json(`${base}/status`)).toMatchObject({ paused: false });
    } finally {
      await server.close();
    }
  });
});

async function json(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json();
}
```

- [ ] **Step 3: Run engine and server tests to verify they fail**

Run:

```bash
pnpm test tests/unit/bunny/engine.test.ts tests/unit/bunny/server.test.ts
```

Expected: FAIL because `engine.ts` and `server.ts` do not exist.

- [ ] **Step 4: Implement engine**

Create `src/bunny/engine.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { BunnyGenerator } from './generator';
import { TemplateBunnyGenerator } from './generator';
import { checkDraftQuality, postKeyForDraft } from './quality';
import { planSchedule } from './scheduler';
import { scoreCandidate } from './scoring';
import type { BunnyStore } from './store';
import { XApiAdapter, type XPublishResult } from './x-api';

export interface BunnyEngineOptions {
  store: BunnyStore;
  generator?: BunnyGenerator;
  xApi?: XApiAdapter;
}

export interface BunnyRunOnceResult {
  generatedDrafts: number;
  scheduledPosts: number;
}

export interface BunnyPublishDueResult {
  published: number;
  skipped?: 'paused';
}

export class BunnyEngine {
  private readonly generator: BunnyGenerator;
  private readonly xApi: XApiAdapter;

  constructor(private readonly options: BunnyEngineOptions) {
    this.generator = options.generator ?? new TemplateBunnyGenerator();
    const settings = options.store.getSettings();
    this.xApi = options.xApi ?? new XApiAdapter({ livePublishing: settings.livePublishing });
  }

  status() {
    return this.options.store.status();
  }

  today(nowIso = new Date().toISOString()) {
    return this.options.store.today(nowIso);
  }

  pause(): void {
    this.options.store.setPaused(true);
  }

  resume(): void {
    this.options.store.setPaused(false);
  }

  async runOnce(nowIso = new Date().toISOString()): Promise<BunnyRunOnceResult> {
    const candidates = this.options.store.listCandidates();
    const recentUrls = new Set(this.options.store.listScheduled().map((post) => post.xPostUrl ?? post.postKey));
    const topics = candidates.map((candidate) => scoreCandidate(candidate, recentUrls, nowIso))
      .filter((topic) => topic.score >= 70)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const drafts = [];
    for (const topic of topics) {
      this.options.store.saveTopic(topic);
      const draft = await this.generator.generate(topic, nowIso);
      const quality = checkDraftQuality(draft, new Set());
      this.options.store.saveDraft(quality.ok ? draft : { ...draft, status: 'skipped', qualityFailure: quality.reason });
      if (quality.ok) drafts.push(draft);
    }
    const settings = this.options.store.getSettings();
    const planned = planSchedule({
      draftIds: drafts.map((draft) => draft.id),
      nowIso,
      dailyLimit: settings.dailyPostLimit,
    });
    for (const item of planned) {
      const draft = drafts.find((candidate) => candidate.id === item.draftId);
      if (!draft) continue;
      this.options.store.schedulePost({
        id: randomUUID(),
        draftId: draft.id,
        postKey: postKeyForDraft(draft),
        publishAt: item.publishAt,
        status: 'scheduled',
      });
    }
    return {
      generatedDrafts: drafts.length,
      scheduledPosts: planned.length,
    };
  }

  async publishDue(nowIso = new Date().toISOString()): Promise<BunnyPublishDueResult> {
    if (this.options.store.getSettings().paused) return { published: 0, skipped: 'paused' };
    let published = 0;
    const drafts = new Map(this.options.store.listDrafts().map((draft) => [draft.id, draft]));
    for (const post of this.options.store.claimDuePosts(nowIso)) {
      const draft = drafts.get(post.draftId);
      if (!draft) {
        this.options.store.markFailed(post.postKey, 'draft not found');
        continue;
      }
      const result = await this.xApi.publish({ postKey: post.postKey, text: draft.englishText });
      if (isPublished(result)) {
        this.options.store.markPublished(post.postKey, result.xPostId, result.xPostUrl, nowIso);
        published += 1;
      } else if (result.status === 'dry-run') {
        this.options.store.recordEvent('dry_run_publish', `${post.postKey} ${result.message}`, nowIso);
      } else {
        this.options.store.markFailed(post.postKey, result.message);
      }
    }
    return { published };
  }
}

function isPublished(result: XPublishResult): result is Extract<XPublishResult, { status: 'published' }> {
  return result.status === 'published';
}
```

- [ ] **Step 5: Implement local HTTP server**

Create `src/bunny/server.ts`:

```ts
import { createServer, type Server } from 'node:http';
import type { BunnyEngine } from './engine';

export interface BunnyServerOptions {
  engine: BunnyEngine;
  host: string;
  port: number;
}

export interface BunnyServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startBunnyServer(options: BunnyServerOptions): Promise<BunnyServerHandle> {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/status') return sendJson(res, options.engine.status());
      if (req.method === 'GET' && req.url === '/today') return sendJson(res, options.engine.today());
      if (req.method === 'POST' && req.url === '/pause') {
        options.engine.pause();
        return sendJson(res, { ok: true, paused: true });
      }
      if (req.method === 'POST' && req.url === '/resume') {
        options.engine.resume();
        return sendJson(res, { ok: true, paused: false });
      }
      if (req.method === 'POST' && req.url === '/run-once') return sendJson(res, await options.engine.runOnce());
      if (req.method === 'POST' && req.url === '/publish-due') return sendJson(res, await options.engine.publishDue());
      res.statusCode = 404;
      return sendJson(res, { error: 'not found' });
    } catch (err) {
      res.statusCode = 500;
      return sendJson(res, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    port,
    close: () => closeServer(server),
  };
}

function sendJson(res: { setHeader(name: string, value: string): void; end(body: string): void }, body: unknown): void {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(body)}\n`);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
```

- [ ] **Step 6: Run engine and server tests to verify they pass**

Run:

```bash
pnpm test tests/unit/bunny/engine.test.ts tests/unit/bunny/server.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add Bunny CLI command**

Create `src/cli/commands/bunny.ts`:

```ts
import { dirname } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { resolveBunnyPaths } from '../../bunny/config';
import { BunnyEngine } from '../../bunny/engine';
import { startBunnyServer } from '../../bunny/server';
import { BunnyStore } from '../../bunny/store';

export interface BunnyCliOptions {
  profile?: string;
  config?: string;
  host?: string;
  port?: string;
}

export async function runBunnyServe(opts: BunnyCliOptions): Promise<void> {
  const store = new BunnyStore(await dbFile(opts));
  const server = await startBunnyServer({
    engine: new BunnyEngine({ store }),
    host: opts.host ?? '127.0.0.1',
    port: opts.port ? Number.parseInt(opts.port, 10) : 3827,
  });
  console.log(`Bunny server listening on http://127.0.0.1:${server.port}`);
}

export async function runBunnyRunOnce(opts: BunnyCliOptions): Promise<void> {
  const store = new BunnyStore(await dbFile(opts));
  const result = await new BunnyEngine({ store }).runOnce();
  console.log(JSON.stringify(result, null, 2));
}

export async function runBunnyStatus(opts: BunnyCliOptions): Promise<void> {
  const store = new BunnyStore(await dbFile(opts));
  console.log(JSON.stringify(new BunnyEngine({ store }).status(), null, 2));
}

export async function runBunnyPause(opts: BunnyCliOptions): Promise<void> {
  const store = new BunnyStore(await dbFile(opts));
  new BunnyEngine({ store }).pause();
  console.log('Bunny paused');
}

export async function runBunnyResume(opts: BunnyCliOptions): Promise<void> {
  const store = new BunnyStore(await dbFile(opts));
  new BunnyEngine({ store }).resume();
  console.log('Bunny resumed');
}

async function dbFile(opts: BunnyCliOptions): Promise<string> {
  const envConfig = process.env.LARK_CHANNEL_CONFIG;
  const explicitConfig = opts.config ?? envConfig;
  const rootDir = explicitConfig
    ? dirname(explicitConfig)
    : process.env.LARK_CHANNEL_HOME ?? resolveAppPaths().rootDir;
  const configFile = explicitConfig ?? resolveAppPaths({ rootDir }).configFile;
  const root = await loadRootConfig(configFile);
  const profile = opts.profile ?? await readActiveProfile(rootDir) ?? root?.activeProfile ?? 'default';
  return resolveBunnyPaths(resolveAppPaths({ rootDir, profile })).dbFile;
}
```

Modify `src/cli/index.ts` to import the command functions:

```ts
import {
  runBunnyPause,
  runBunnyResume,
  runBunnyRunOnce,
  runBunnyServe,
  runBunnyStatus,
} from './commands/bunny';
```

Add this command group before `program.parseAsync(...)`:

```ts
const bunny = program
  .command('bunny')
  .description('Run and inspect the Bunny AI tools media agent');

bunny.command('serve')
  .description('Start the local Bunny control server')
  .option('--profile <name>', 'profile name')
  .option('-c, --config <path>', 'path to config file')
  .option('--host <host>', 'listen host, default 127.0.0.1')
  .option('--port <port>', 'listen port, default 3827')
  .action(async (opts: { profile?: string; config?: string; host?: string; port?: string }) => {
    await runBunnyServe(opts);
  });

bunny.command('run-once')
  .description('Run one Bunny ingestion/generation/scheduling cycle')
  .option('--profile <name>', 'profile name')
  .option('-c, --config <path>', 'path to config file')
  .action(async (opts: { profile?: string; config?: string }) => {
    await runBunnyRunOnce(opts);
  });

bunny.command('status')
  .description('Print Bunny status as JSON')
  .option('--profile <name>', 'profile name')
  .option('-c, --config <path>', 'path to config file')
  .action(async (opts: { profile?: string; config?: string }) => {
    await runBunnyStatus(opts);
  });

bunny.command('pause')
  .description('Pause Bunny publishing')
  .option('--profile <name>', 'profile name')
  .option('-c, --config <path>', 'path to config file')
  .action(async (opts: { profile?: string; config?: string }) => {
    await runBunnyPause(opts);
  });

bunny.command('resume')
  .description('Resume Bunny publishing')
  .option('--profile <name>', 'profile name')
  .option('-c, --config <path>', 'path to config file')
  .action(async (opts: { profile?: string; config?: string }) => {
    await runBunnyResume(opts);
  });
```

- [ ] **Step 8: Update CLI registration test**

Modify `tests/unit/cli/index-registration.test.ts` to assert `bunny` appears in the help output. Use the existing test's helper pattern and add:

```ts
expect(help).toContain('bunny');
expect(help).toContain('Run and inspect the Bunny AI tools media agent');
```

- [ ] **Step 9: Run CLI and Bunny tests**

Run:

```bash
pnpm test tests/unit/bunny/engine.test.ts tests/unit/bunny/server.test.ts tests/unit/cli/index-registration.test.ts
pnpm typecheck
```

Expected: PASS for tests and typecheck.

- [ ] **Step 10: Commit**

Run:

```bash
git add src/bunny/engine.ts src/bunny/server.ts src/cli/commands/bunny.ts src/cli/index.ts tests/unit/bunny/engine.test.ts tests/unit/bunny/server.test.ts tests/unit/cli/index-registration.test.ts
git commit -m "feat: add bunny engine server and cli"
```

---

### Task 7: `/bunny` Bridge Command Integration

**Files:**
- Create: `src/bunny/command-service.ts`
- Modify: `src/commands/index.ts`
- Test: `tests/integration/commands/bunny-command.test.ts`

- [ ] **Step 1: Write failing bridge command tests**

Create `tests/integration/commands/bunny-command.test.ts` using the upgrade command harness pattern:

```ts
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  bunny: {
    status: ReturnType<typeof vi.fn<() => Promise<string>>>;
    today: ReturnType<typeof vi.fn<() => Promise<string>>>;
    pause: ReturnType<typeof vi.fn<() => Promise<string>>>;
    resume: ReturnType<typeof vi.fn<() => Promise<string>>>;
  };
  run(content: string, overrides?: { senderId?: string; chatMode?: CommandContext['chatMode'] }): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('Lark bunny command', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('allows admin p2p Bunny status', async () => {
    const h = await createHarness();
    h.bunny.status.mockResolvedValue('Bunny 正常运行。');

    await expect(h.run('/bunny status')).resolves.toBe(true);

    expect(h.bunny.status).toHaveBeenCalledTimes(1);
    expect(lastMarkdown(h.channel)).toContain('正常运行');
  });

  it('rejects Bunny commands in groups', async () => {
    const h = await createHarness();

    await expect(h.run('/bunny status', { chatMode: 'group' })).resolves.toBe(true);

    expect(h.bunny.status).not.toHaveBeenCalled();
    expect(lastMarkdown(h.channel)).toContain('请私聊 bot 使用');
  });

  it('runs today pause and resume', async () => {
    const h = await createHarness();
    h.bunny.today.mockResolvedValue('今天计划 2 条。');
    h.bunny.pause.mockResolvedValue('Bunny 已暂停。');
    h.bunny.resume.mockResolvedValue('Bunny 已恢复。');

    await h.run('/bunny today');
    expect(lastMarkdown(h.channel)).toContain('今天计划');

    await h.run('/bunny pause');
    expect(lastMarkdown(h.channel)).toContain('已暂停');

    await h.run('/bunny resume');
    expect(lastMarkdown(h.channel)).toContain('已恢复');
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('bunny-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const workspaceRealpath = await realpath(tmp.workspace);
  const profileConfig = appConfig(workspaceRealpath);
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const bunny = {
    status: vi.fn(async () => 'Bunny idle.'),
    today: vi.fn(async () => '今天没有计划。'),
    pause: vi.fn(async () => 'Bunny 已暂停。'),
    resume: vi.fn(async () => 'Bunny 已恢复。'),
  };

  workspaces.setCwd('chat-1', workspaceRealpath);

  const run = (content: string, overrides: { senderId?: string; chatMode?: CommandContext['chatMode'] } = {}) =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, {
        senderId: overrides.senderId ?? 'ou-admin',
      }),
      scope: 'chat-1',
      chatMode: overrides.chatMode ?? 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
      bunnyCommandService: bunny,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, bunny, run };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string, opts: { senderId: string }): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: opts.senderId,
    senderName: 'User',
    content,
    resources: [],
    mentions: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: unknown } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content.markdown as string;
}
```

- [ ] **Step 2: Run bridge command tests to verify they fail**

Run:

```bash
pnpm test tests/integration/commands/bunny-command.test.ts
```

Expected: FAIL because `bunnyCommandService` and `/bunny` are not registered.

- [ ] **Step 3: Implement bridge-side Bunny command service**

Create `src/bunny/command-service.ts`:

```ts
import { loadBunnyConfigFromEnv } from './config';
import type { BunnyStatus, BunnyToday } from './types';

export interface BunnyCommandService {
  status(): Promise<string>;
  today(): Promise<string>;
  pause(): Promise<string>;
  resume(): Promise<string>;
}

export function createBunnyCommandService(baseUrl = loadBunnyConfigFromEnv().baseUrl): BunnyCommandService {
  return {
    status: async () => formatStatus(await requestJson<BunnyStatus>(baseUrl, '/status')),
    today: async () => formatToday(await requestJson<BunnyToday>(baseUrl, '/today')),
    pause: async () => {
      await requestJson(baseUrl, '/pause', { method: 'POST' });
      return 'Bunny 已暂停发布。';
    },
    resume: async () => {
      await requestJson(baseUrl, '/resume', { method: 'POST' });
      return 'Bunny 已恢复发布。';
    },
  };
}

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) throw new Error(`Bunny service ${response.status}`);
  return response.json() as Promise<T>;
}

function formatStatus(status: BunnyStatus): string {
  return [
    `Bunny: ${status.paused ? '已暂停' : '运行中'}`,
    `发布模式: ${status.livePublishing ? 'live' : 'dry-run'}`,
    `队列: ${status.queuedPosts}`,
    `每日预算: ${status.dailyCreditBudget} credits`,
    status.lastPublishedAt ? `最近发布: ${status.lastPublishedAt}` : undefined,
    status.lastError ? `最近错误: ${status.lastError}` : undefined,
  ].filter(Boolean).join('\n');
}

function formatToday(today: BunnyToday): string {
  const rows = today.scheduled.map((post) => `- ${post.publishAt} ${post.status} \`${post.postKey}\``);
  const drafts = today.drafts.slice(0, 3).map((draft) => `- ${draft.englishText.split('\n')[0] ?? draft.id}`);
  return [
    `今日排期: ${today.scheduled.length}`,
    ...rows,
    '',
    `最新草稿: ${today.drafts.length}`,
    ...drafts,
  ].join('\n').trim();
}
```

- [ ] **Step 4: Register `/bunny` command**

Modify `src/commands/index.ts`:

Add the import:

```ts
import { createBunnyCommandService, type BunnyCommandService } from '../bunny/command-service';
```

Add to `CommandContext`:

```ts
  bunnyCommandService?: BunnyCommandService;
```

Add to `handlers`:

```ts
  '/bunny': handleBunny,
```

Add `'/bunny'` to `ADMIN_COMMANDS`.

Add the handler near `handleUpgrade`:

```ts
async function handleBunny(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    await reply(ctx, '❌ 请私聊 bot 发送文字命令 `/bunny`。');
    return;
  }
  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '❌ 请私聊 bot 使用 `/bunny`。');
    return;
  }
  const service = ctx.bunnyCommandService ?? createBunnyCommandService();
  const [sub = 'status'] = args.trim().split(/\s+/).filter(Boolean);
  if (sub === 'status') return reply(ctx, await service.status());
  if (sub === 'today') return reply(ctx, await service.today());
  if (sub === 'pause') return reply(ctx, await service.pause());
  if (sub === 'resume') return reply(ctx, await service.resume());
  await reply(ctx, '用法: `/bunny [status|today|pause|resume]`');
}
```

- [ ] **Step 5: Run bridge command tests to verify they pass**

Run:

```bash
pnpm test tests/integration/commands/bunny-command.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/bunny/command-service.ts src/commands/index.ts tests/integration/commands/bunny-command.test.ts
git commit -m "feat: add bunny bridge command"
```

---

### Task 8: Metrics And Daily Report Formatter

**Files:**
- Create: `src/bunny/reporter.ts`
- Modify: `src/bunny/command-service.ts`
- Test: `tests/unit/bunny/reporter.test.ts`

- [ ] **Step 1: Write failing reporter tests**

Create `tests/unit/bunny/reporter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildDailyReport } from '../../../src/bunny/reporter';
import type { BunnyStatus, BunnyToday } from '../../../src/bunny/types';

describe('Bunny reporter', () => {
  it('summarizes schedule, drafts, metrics, and mode', () => {
    const today: BunnyToday = {
      scheduled: [
        {
          id: 'sched-1',
          draftId: 'draft-1',
          postKey: 'post-key-1',
          publishAt: '2026-06-23T12:00:00.000Z',
          status: 'published',
          xPostId: '12345',
          xPostUrl: 'https://x.com/i/web/status/12345',
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
          createdAt: '2026-06-23T10:00:00.000Z',
        },
      ],
    };
    const status: BunnyStatus = {
      paused: false,
      livePublishing: false,
      queuedPosts: 1,
      dailyCreditBudget: 50,
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
  const header = [
    '**Bunny Daily Report**',
    `Mode: ${mode}`,
    `State: ${status.paused ? 'paused' : 'running'}`,
    `Queue: ${status.queuedPosts}`,
    `Daily budget: ${status.dailyCreditBudget} credits`,
  ];
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
    ...header,
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

- [ ] **Step 4: Use reporter in Bunny command service**

Modify `src/bunny/command-service.ts`:

```ts
import { buildDailyReport } from './reporter';
```

Replace `formatToday()` with:

```ts
function formatToday(today: BunnyToday): string {
  return buildDailyReport(today, {
    paused: false,
    livePublishing: false,
    queuedPosts: today.scheduled.filter((post) => post.status === 'scheduled').length,
    dailyCreditBudget: 50,
  }, new Map());
}
```

- [ ] **Step 5: Run reporter and command tests**

Run:

```bash
pnpm test tests/unit/bunny/reporter.test.ts tests/integration/commands/bunny-command.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/bunny/reporter.ts src/bunny/command-service.ts tests/unit/bunny/reporter.test.ts
git commit -m "feat: add bunny daily reporter"
```

---

### Task 9: Documentation And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Test: `tests/unit/docs/readme-contract.test.ts`

- [ ] **Step 1: Add README contract expectations**

Modify `tests/unit/docs/readme-contract.test.ts` to assert both READMEs mention Bunny commands:

```ts
expect(docs).toContain('bunny serve');
expect(docs).toContain('/bunny status');
expect(docs).toContain('Bunny AI tools media agent');
expect(docs).toContain('Bunny AI 工具自媒体 agent');
```

- [ ] **Step 2: Run README contract test to verify it fails**

Run:

```bash
pnpm test tests/unit/docs/readme-contract.test.ts
```

Expected: FAIL because the README files do not mention Bunny.

- [ ] **Step 3: Document Bunny in `README.md`**

Add a short section after the commands table:

````md
### Bunny AI tools media agent

Bunny is an optional local service for AI tools X/Twitter content operations.
It is isolated from bridge core and is controlled through a thin `/bunny`
command surface.

Start Bunny for the active profile:

```bash
lark-channel-bridge bunny serve --profile codex
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `/bunny status` | Show Bunny status, queue size, mode, and budget state |
| `/bunny today` | Show today's scheduled posts and latest drafts |
| `/bunny pause` | Pause publishing while keeping generation available |
| `/bunny resume` | Resume publishing |

Bunny starts with live publishing disabled. Configure X API credentials through
environment variables and validate dry-run output before enabling live posting.
````

- [ ] **Step 4: Document Bunny in `README.zh.md`**

Add the Chinese equivalent after the commands table:

````md
### Bunny AI 工具自媒体 agent

Bunny 是可选的本地服务，用来做 AI 工具方向的 X/Twitter 内容运营。
它和 bridge 核心隔离，bridge 只提供很薄的 `/bunny` 控制入口。

为当前 profile 启动 Bunny：

```bash
lark-channel-bridge bunny serve --profile codex
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/bunny status` | 查看 Bunny 状态、队列、模式和预算状态 |
| `/bunny today` | 查看今天的排期和最新草稿 |
| `/bunny pause` | 暂停发布，但保留采集和生成 |
| `/bunny resume` | 恢复发布 |

Bunny 默认关闭 live 发布。先通过环境变量配置 X API 凭据，并完成 dry-run
验证后，再启用真实发布。
````

- [ ] **Step 5: Run focused docs test**

Run:

```bash
pnpm test tests/unit/docs/readme-contract.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: all three commands exit 0.

- [ ] **Step 7: Commit**

Run:

```bash
git add README.md README.zh.md tests/unit/docs/readme-contract.test.ts
git commit -m "docs: document bunny agent"
```

---

## Final Handoff Checklist

- [ ] `lark-channel-bridge bunny status --profile <profile>` prints Bunny JSON status.
- [ ] `lark-channel-bridge bunny serve --profile <profile>` starts a local server.
- [ ] `/bunny status` in a p2p admin chat returns Bunny status.
- [ ] `/bunny today` shows scheduled posts and latest drafts.
- [ ] `/bunny pause` and `/bunny resume` update persisted pause state.
- [ ] Dry-run mode never calls X API.
- [ ] Live mode requires `BUNNY_X_BEARER_TOKEN`.
- [ ] Duplicate `post_key` values do not create duplicate scheduled posts.
- [ ] Full verification passes: `pnpm test`, `pnpm typecheck`, `pnpm build`.
