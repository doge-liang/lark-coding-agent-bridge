import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { defaultBunnySettings } from './config';
import type {
  BunnyCandidate,
  BunnyDraft,
  BunnyPostKind,
  BunnyPostStatus,
  BunnyScheduledPost,
  BunnySettings,
  BunnyStatus,
  BunnyToday,
  BunnyTopic,
} from './types';

type Row = Record<string, unknown>;

const validKinds: BunnyPostKind[] = ['single', 'thread'];
const validStatuses: BunnyPostStatus[] = ['draft', 'scheduled', 'publishing', 'published', 'failed', 'skipped'];

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
    const row = this.db
      .prepare('select value from settings where key = ?')
      .get('settings') as Row | undefined;

    return row ? (JSON.parse(String(row.value)) as BunnySettings) : defaultBunnySettings();
  }

  saveSettings(settings: BunnySettings): void {
    this.db
      .prepare(
        'insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value',
      )
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
    this.db
      .prepare(`
        insert into candidates(id, source_id, title, url, summary, discovered_at)
        values(@id, @sourceId, @title, @url, @summary, @discoveredAt)
        on conflict(id) do update set
          source_id = excluded.source_id,
          title = excluded.title,
          url = excluded.url,
          summary = excluded.summary,
          discovered_at = excluded.discovered_at
      `)
      .run(candidate);
  }

  listCandidates(): BunnyCandidate[] {
    const rows = this.db.prepare('select * from candidates order by discovered_at desc').all() as Row[];
    return rows.map(candidateFromRow);
  }

  saveTopic(topic: BunnyTopic): void {
    this.db
      .prepare(`
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
      `)
      .run(topic);
  }

  listTopics(): BunnyTopic[] {
    const rows = this.db.prepare('select * from topics order by score desc, created_at desc').all() as Row[];
    return rows.map(topicFromRow);
  }

  saveDraft(draft: BunnyDraft): void {
    this.db
      .prepare(`
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
      `)
      .run({ ...draft, qualityFailure: draft.qualityFailure ?? null });
  }

  listDrafts(): BunnyDraft[] {
    const rows = this.db.prepare('select * from drafts order by created_at desc').all() as Row[];
    return rows.map(draftFromRow);
  }

  schedulePost(post: BunnyScheduledPost): void {
    this.db
      .prepare(`
        insert into scheduled_posts(id, draft_id, post_key, publish_at, status, x_post_id, x_post_url, error_message)
        values(@id, @draftId, @postKey, @publishAt, 'scheduled', @xPostId, @xPostUrl, @errorMessage)
        on conflict(post_key) do update set
          draft_id = excluded.draft_id,
          publish_at = excluded.publish_at,
          status = 'scheduled',
          x_post_id = excluded.x_post_id,
          x_post_url = excluded.x_post_url,
          error_message = excluded.error_message
      `)
      .run({
        ...post,
        xPostId: post.xPostId ?? null,
        xPostUrl: post.xPostUrl ?? null,
        errorMessage: post.errorMessage ?? null,
      });
  }

  listScheduled(): BunnyScheduledPost[] {
    const rows = this.db.prepare('select * from scheduled_posts order by publish_at asc').all() as Row[];
    return rows.map(scheduledFromRow);
  }

  claimDuePosts(nowIso: string): BunnyScheduledPost[] {
    const selectDue = this.db.prepare(`
      select * from scheduled_posts
      where status = 'scheduled' and publish_at <= ?
      order by publish_at asc
    `);
    const claimRows = this.db.prepare(`
      update scheduled_posts
      set status = 'publishing'
      where id = @id and status = 'scheduled'
    `);

    const transaction = this.db.transaction(() => {
      const rows = selectDue.all(nowIso) as Row[];
      if (rows.length === 0) return [];

      for (const row of rows) {
        claimRows.run({ id: String(row.id) });
      }

      return rows.map((row) => ({
        ...row,
        status: 'publishing',
      }));
    });

    const claimed = transaction();
    return (claimed as Row[]).map(scheduledFromRow);
  }

  markPublished(postKey: string, xPostId: string, xPostUrl: string, nowIso: string): void {
    const result = this.db
      .prepare(`
        update scheduled_posts
        set status = 'published', x_post_id = ?, x_post_url = ?, error_message = null
        where post_key = ? and status = 'publishing'
      `)
      .run(xPostId, xPostUrl, postKey);
    if (result.changes > 0) {
      this.recordEvent('published', `${postKey} ${xPostId}`, nowIso);
    }
  }

  markFailed(postKey: string, errorMessage: string): void {
    const result = this.db
      .prepare(`
        update scheduled_posts
        set status = 'failed', error_message = ?
        where post_key = ? and status = 'publishing'
      `)
      .run(errorMessage, postKey);
    if (result.changes > 0) {
      this.recordEvent('publish_failed', `${postKey} ${errorMessage}`);
    }
  }

  recordMetric(input: {
    postKey: string;
    impressions: number;
    likes: number;
    reposts: number;
    replies: number;
    capturedAt: string;
  }): void {
    this.db
      .prepare(
        `
        insert into metrics(post_key, impressions, likes, reposts, replies, captured_at)
        values(@postKey, @impressions, @likes, @reposts, @replies, @capturedAt)
      `,
      )
      .run(input);
  }

  listMetrics(postKey: string): Array<{
    postKey: string;
    impressions: number;
    likes: number;
    reposts: number;
    replies: number;
    capturedAt: string;
  }> {
    const rows = this.db
      .prepare('select * from metrics where post_key = ? order by captured_at desc')
      .all(postKey) as Row[];
    return rows.map((row) => ({
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
    const rows = this.db
      .prepare(`
        select * from scheduled_posts
        where substr(publish_at, 1, 10) = ?
        order by publish_at asc
      `)
      .all(day) as Row[];

    return {
      scheduled: rows.map(scheduledFromRow),
      drafts: this.listDrafts().slice(0, 10),
    };
  }

  status(): BunnyStatus {
    const settings = this.getSettings();
    const queued = this.db.prepare("select count(*) as count from scheduled_posts where status = 'scheduled'").get() as {
      count: number;
    };
    const lastPublished = this.db
      .prepare(`
        select publish_at from scheduled_posts where status = 'published' order by publish_at desc limit 1
      `)
      .get() as { publish_at?: string } | undefined;
    const lastError = this.db
      .prepare(`
        select error_message from scheduled_posts where error_message is not null order by publish_at desc limit 1
      `)
      .get() as { error_message?: string } | undefined;

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
        kind text not null check (kind in ('single','thread')),
        chinese_note text not null,
        english_text text not null,
        source_url text not null,
        status text not null check (status in ('draft','scheduled','publishing','published','failed','skipped')),
        quality_failure text,
        created_at text not null
      );
      create table if not exists scheduled_posts(
        id text primary key,
        draft_id text not null,
        post_key text not null unique,
        publish_at text not null,
        status text not null check (status in ('draft','scheduled','publishing','published','failed','skipped')),
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
    kind: parseBunnyPostKind(row.kind),
    chineseNote: String(row.chinese_note),
    englishText: String(row.english_text),
    sourceUrl: String(row.source_url),
    status: parseBunnyPostStatus(row.status),
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
    status: parseBunnyPostStatus(row.status),
    ...(row.x_post_id ? { xPostId: String(row.x_post_id) } : {}),
    ...(row.x_post_url ? { xPostUrl: String(row.x_post_url) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
  };
}

function parseBunnyPostKind(rawKind: unknown): BunnyPostKind {
  if (isBunnyPostKind(rawKind)) {
    return rawKind;
  }
  throw new Error(`invalid bunny post kind: ${String(rawKind)}`);
}

function parseBunnyPostStatus(rawStatus: unknown): BunnyPostStatus {
  if (isBunnyPostStatus(rawStatus)) {
    return rawStatus;
  }
  throw new Error(`invalid bunny post status: ${String(rawStatus)}`);
}

function isBunnyPostKind(rawKind: unknown): rawKind is BunnyPostKind {
  return typeof rawKind === 'string' && validKinds.includes(rawKind as BunnyPostKind);
}

function isBunnyPostStatus(rawStatus: unknown): rawStatus is BunnyPostStatus {
  return (
    typeof rawStatus === 'string' && validStatuses.includes(rawStatus as BunnyPostStatus)
  );
}
