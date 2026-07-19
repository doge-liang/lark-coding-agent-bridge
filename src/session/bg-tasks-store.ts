import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Persistent registry for `/bg` background agents. Durability is the whole
 * point: a task must survive a bridge restart so the startup recovery pass can
 * resume it (session-level recovery — see BackgroundRunManager). SQLite (WAL)
 * is used rather than the JSON session store because up to 5 background runs
 * mutate rows concurrently.
 */

export type BgTaskStatus = 'running' | 'resuming' | 'done' | 'error' | 'interrupted';

const ACTIVE_STATUSES: readonly BgTaskStatus[] = ['running', 'resuming'];
const VALID_STATUSES: readonly BgTaskStatus[] = [
  'running',
  'resuming',
  'done',
  'error',
  'interrupted',
];

export interface BgTask {
  taskId: string;
  chatId: string;
  scopeId: string;
  /** open_id of the user who started the task — bg runs (and their post-restart
   *  recovery) execute under this actor's access, mirroring the foreground. */
  actorId: string;
  /** Chat type at submit time, so recovery re-derives access the same way. */
  chatType: string;
  prompt: string;
  sessionId?: string;
  model?: string;
  permissionMode?: string;
  cwd: string;
  cardId?: string;
  status: BgTaskStatus;
  /** Human-readable last progress marker, e.g. "运行工具 Bash". */
  lastNode?: string;
  createdAt: number;
  updatedAt: number;
}

/** Fields that may be patched after creation. */
export interface BgTaskPatch {
  status?: BgTaskStatus;
  sessionId?: string;
  cardId?: string;
  lastNode?: string;
  updatedAt?: number;
}

type Row = Record<string, unknown>;

export class BgTasksStore {
  private readonly db: Database.Database;

  constructor(dbFile: string) {
    mkdirSync(dirname(dbFile), { recursive: true });
    this.db = new Database(dbFile);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  create(task: BgTask): void {
    this.db
      .prepare(`
        insert into bg_tasks(
          task_id, chat_id, scope_id, actor_id, chat_type, prompt, session_id, model,
          permission_mode, cwd, card_id, status, last_node, created_at, updated_at
        ) values(
          @taskId, @chatId, @scopeId, @actorId, @chatType, @prompt, @sessionId, @model,
          @permissionMode, @cwd, @cardId, @status, @lastNode, @createdAt, @updatedAt
        )
      `)
      .run({
        taskId: task.taskId,
        chatId: task.chatId,
        scopeId: task.scopeId,
        actorId: task.actorId,
        chatType: task.chatType,
        prompt: task.prompt,
        sessionId: task.sessionId ?? null,
        model: task.model ?? null,
        permissionMode: task.permissionMode ?? null,
        cwd: task.cwd,
        cardId: task.cardId ?? null,
        status: task.status,
        lastNode: task.lastNode ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
  }

  /** Patch a subset of mutable fields. Only provided keys are written. */
  update(taskId: string, patch: BgTaskPatch): void {
    const sets: string[] = [];
    const params: Row = { taskId };
    if (patch.status !== undefined) {
      sets.push('status = @status');
      params.status = patch.status;
    }
    if (patch.sessionId !== undefined) {
      sets.push('session_id = @sessionId');
      params.sessionId = patch.sessionId;
    }
    if (patch.cardId !== undefined) {
      sets.push('card_id = @cardId');
      params.cardId = patch.cardId;
    }
    if (patch.lastNode !== undefined) {
      sets.push('last_node = @lastNode');
      params.lastNode = patch.lastNode;
    }
    // updated_at always advances on a patch; caller may override the clock.
    sets.push('updated_at = @updatedAt');
    params.updatedAt = patch.updatedAt ?? Date.now();
    this.db.prepare(`update bg_tasks set ${sets.join(', ')} where task_id = @taskId`).run(params);
  }

  get(taskId: string): BgTask | undefined {
    const row = this.db.prepare('select * from bg_tasks where task_id = ?').get(taskId) as
      | Row
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Tasks for a chat, newest first — backs `/bg list`. */
  listByChat(chatId: string): BgTask[] {
    const rows = this.db
      .prepare('select * from bg_tasks where chat_id = ? order by created_at desc')
      .all(chatId) as Row[];
    return rows.map(fromRow);
  }

  /** Tasks still marked active — backs the startup recovery pass. */
  listActive(): BgTask[] {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`select * from bg_tasks where status in (${placeholders}) order by created_at asc`)
      .all(...ACTIVE_STATUSES) as Row[];
    return rows.map(fromRow);
  }

  countActive(): number {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const row = this.db
      .prepare(`select count(*) as n from bg_tasks where status in (${placeholders})`)
      .get(...ACTIVE_STATUSES) as { n: number };
    return row.n;
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists bg_tasks(
        task_id text primary key,
        chat_id text not null,
        scope_id text not null,
        actor_id text not null,
        chat_type text not null,
        prompt text not null,
        session_id text,
        model text,
        permission_mode text,
        cwd text not null,
        card_id text,
        status text not null check (status in ('running','resuming','done','error','interrupted')),
        last_node text,
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists bg_tasks_chat_idx on bg_tasks(chat_id, created_at);
      create index if not exists bg_tasks_status_idx on bg_tasks(status);
    `);
  }
}

function fromRow(row: Row): BgTask {
  return {
    taskId: String(row.task_id),
    chatId: String(row.chat_id),
    scopeId: String(row.scope_id),
    actorId: String(row.actor_id),
    chatType: String(row.chat_type),
    prompt: String(row.prompt),
    ...(row.session_id != null ? { sessionId: String(row.session_id) } : {}),
    ...(row.model != null ? { model: String(row.model) } : {}),
    ...(row.permission_mode != null ? { permissionMode: String(row.permission_mode) } : {}),
    cwd: String(row.cwd),
    ...(row.card_id != null ? { cardId: String(row.card_id) } : {}),
    status: parseStatus(row.status),
    ...(row.last_node != null ? { lastNode: String(row.last_node) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function parseStatus(raw: unknown): BgTaskStatus {
  if (typeof raw === 'string' && VALID_STATUSES.includes(raw as BgTaskStatus)) {
    return raw as BgTaskStatus;
  }
  throw new Error(`invalid bg task status: ${String(raw)}`);
}
