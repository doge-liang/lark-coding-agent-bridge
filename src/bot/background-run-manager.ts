import type { RunExecution } from '../runtime/run-executor';
import { ProcessPool } from './process-pool';
import { log } from '../core/logger';
import { BgTasksStore, type BgTask, type BgTaskStatus } from '../session/bg-tasks-store';

/**
 * Orchestrates `/bg` background agents: a task runs on its own scope so it never
 * contends with the foreground conversation, is capped at N concurrent by a
 * dedicated pool (the global process ceiling still applies underneath, via the
 * shared RunExecutor), is persisted for restart survival, and reports progress
 * onto its own Feishu card.
 *
 * The manager is deliberately decoupled from run-policy / channel wiring: the
 * caller injects `startRun` (which closes over access/capability/profileConfig
 * and calls startRunFlow with the bg scope), the card renderer, and the
 * proactive notifier. This keeps the concurrency + persistence + lifecycle
 * logic unit-testable with fakes.
 */

export interface BgStartResult {
  ok: boolean;
  /** Populated on ok: the live execution to drive. */
  execution?: RunExecution;
  /** Populated on !ok: a user-facing reason. */
  reason?: string;
}

export interface BgCardView {
  task: BgTask;
  /** Short progress line shown on the card, e.g. "运行工具 Bash". */
  progress: string;
  /** Accumulated assistant text so far (may be empty). */
  text: string;
}

export interface BackgroundRunManagerDeps {
  store: BgTasksStore;
  /**
   * Start a run for a bg task on its own scope. Recovery resumes automatically:
   * the wiring's startRun calls startRunFlow, which resumes from SessionStore by
   * scopeId — provided `recordSession` persisted the session on the first run.
   */
  startRun(input: {
    scopeId: string;
    chatId: string;
    prompt: string;
    actorId: string;
    chatType: string;
  }): Promise<BgStartResult>;
  /**
   * Persist a run's session id keyed by the bg scope so a post-restart
   * startRunFlow resumes the same conversation. Mirrors the foreground's
   * recordRunSessionEvent for the SessionStore.
   */
  recordSession?(scopeId: string, sessionId: string, cwd: string): void;
  /** Post the initial task card; resolves to the card id for later updates. */
  postCard(chatId: string, view: BgCardView): Promise<string | undefined>;
  /** Update an existing task card. */
  updateCard(chatId: string, cardId: string, view: BgCardView): Promise<void>;
  /** Proactively send a plain message to the chat (terminal notification). */
  notify(chatId: string, text: string): Promise<void>;
  maxConcurrent?: number;
  /** Min gap between mid-run card updates, to respect Feishu card rate limits. */
  cardMinIntervalMs?: number;
  now?: () => number;
  genId?: () => string;
}

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_CARD_MIN_INTERVAL_MS = 5000;

export class BackgroundRunManager {
  private readonly deps: BackgroundRunManagerDeps;
  private readonly pool: ProcessPool;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly cardMinIntervalMs: number;
  /** taskId -> live execution, for stop(). */
  private readonly live = new Map<string, RunExecution>();

  constructor(deps: BackgroundRunManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.genId = deps.genId ?? (() => `bg-${Math.random().toString(36).slice(2, 8)}`);
    this.cardMinIntervalMs = deps.cardMinIntervalMs ?? DEFAULT_CARD_MIN_INTERVAL_MS;
    this.pool = new ProcessPool(() => deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  }

  /** Number of currently in-memory live background runs. */
  liveCount(): number {
    return this.live.size;
  }

  list(chatId: string): BgTask[] {
    return this.deps.store.listByChat(chatId);
  }

  /**
   * Kick off a new background task. Returns the taskId once the run is accepted
   * (the run itself proceeds asynchronously), or a rejection reason.
   */
  async submit(input: {
    chatId: string;
    scopeBase: string;
    prompt: string;
    actorId: string;
    chatType: string;
  }): Promise<{ ok: true; taskId: string } | { ok: false; reason: string }> {
    const slot = this.pool.tryAcquire();
    if (!slot) {
      return { ok: false, reason: `后台任务已达上限（${this.deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT} 个），请等已有任务结束。` };
    }
    const taskId = this.genId();
    const scopeId = `${input.scopeBase}:bg:${taskId}`;
    const ts = this.now();
    const task: BgTask = {
      taskId,
      chatId: input.chatId,
      scopeId,
      actorId: input.actorId,
      chatType: input.chatType,
      prompt: input.prompt,
      cwd: '',
      status: 'running',
      lastNode: '已排队',
      createdAt: ts,
      updatedAt: ts,
    };
    this.deps.store.create(task);

    let cardId: string | undefined;
    try {
      cardId = await this.deps.postCard(input.chatId, { task, progress: '已排队', text: '' });
      if (cardId) this.deps.store.update(taskId, { cardId, updatedAt: this.now() });
    } catch (err) {
      log.warn('bg', 'card-post-failed', { taskId, error: errMsg(err) });
    }

    const started = await this.deps.startRun({
      scopeId,
      chatId: input.chatId,
      prompt: input.prompt,
      actorId: input.actorId,
      chatType: input.chatType,
    });
    if (!started.ok || !started.execution) {
      this.finish(task, cardId, 'error', started.reason ?? '启动失败', '');
      slot();
      return { ok: false, reason: started.reason ?? '后台任务启动失败。' };
    }

    // Drive the run without blocking the command response.
    void this.drive(task, cardId, started.execution, slot);
    return { ok: true, taskId };
  }

  /** Stop a running background task. */
  async stop(taskId: string): Promise<boolean> {
    const execution = this.live.get(taskId);
    if (!execution) return false;
    await execution.stop().catch(() => {});
    return true;
  }

  /**
   * Startup recovery: re-launch tasks left active by a previous process.
   * Session-level precision — a task interrupted mid-tool-call resumes the
   * conversation and may redo the interrupted step.
   */
  async recover(): Promise<number> {
    const active = this.deps.store.listActive();
    let resumed = 0;
    for (const task of active) {
      const slot = this.pool.tryAcquire();
      if (!slot) {
        // Over capacity on recovery — leave the rest interrupted for the user.
        this.deps.store.update(task.taskId, { status: 'interrupted', lastNode: '重启时超出并发上限', updatedAt: this.now() });
        continue;
      }
      this.deps.store.update(task.taskId, { status: 'resuming', lastNode: '重启恢复中', updatedAt: this.now() });
      const view: BgCardView = { task: { ...task, status: 'resuming' }, progress: '重启恢复中', text: '' };
      if (task.cardId) await this.deps.updateCard(task.chatId, task.cardId, view).catch(() => {});
      const started = await this.deps.startRun({
        scopeId: task.scopeId,
        chatId: task.chatId,
        prompt: task.prompt,
        actorId: task.actorId,
        chatType: task.chatType,
      });
      if (!started.ok || !started.execution) {
        this.finish(task, task.cardId, 'error', started.reason ?? '恢复失败', '');
        slot();
        continue;
      }
      void this.drive(task, task.cardId, started.execution, slot);
      resumed++;
    }
    if (resumed > 0) log.info('bg', 'recovered', { resumed, total: active.length });
    return resumed;
  }

  private async drive(
    task: BgTask,
    cardId: string | undefined,
    execution: RunExecution,
    slot: () => void,
  ): Promise<void> {
    this.live.set(task.taskId, execution);
    let progress = '运行中';
    let text = '';
    let sessionId = task.sessionId;
    let lastCardAt = 0;
    let terminal: BgTaskStatus | undefined;

    const pushCard = async (force: boolean): Promise<void> => {
      if (!cardId) return;
      const now = this.now();
      if (!force && now - lastCardAt < this.cardMinIntervalMs) return;
      lastCardAt = now;
      await this.deps
        .updateCard(task.chatId, cardId, { task: { ...task, status: 'running', lastNode: progress }, progress, text })
        .catch((err) => log.warn('bg', 'card-update-failed', { taskId: task.taskId, error: errMsg(err) }));
    };

    try {
      for await (const evt of execution.subscribe()) {
        if (evt.type === 'system' && evt.sessionId && evt.sessionId !== sessionId) {
          // Persist the fresh session id as soon as it lands so recovery can
          // resume this exact conversation after a restart — both into the bg
          // store (for display/robustness) and the SessionStore (so
          // startRunFlow auto-resumes it on the next process).
          sessionId = evt.sessionId;
          this.deps.store.update(task.taskId, { sessionId, updatedAt: this.now() });
          this.deps.recordSession?.(task.scopeId, evt.sessionId, evt.cwd ?? '');
        } else if (evt.type === 'text') {
          text += evt.delta;
          progress = '生成回复中';
          await pushCard(false);
        } else if (evt.type === 'thinking') {
          progress = '思考中';
          await pushCard(false);
        } else if (evt.type === 'tool_use') {
          // A key node — persist it so the card survives a restart mid-tool.
          progress = `运行工具 ${evt.name}`;
          this.deps.store.update(task.taskId, { lastNode: progress, updatedAt: this.now() });
          await pushCard(true);
        } else if (evt.type === 'tool_result') {
          progress = '工具完成';
          await pushCard(false);
        } else if (evt.type === 'done') {
          terminal = 'done';
          break;
        } else if (evt.type === 'error') {
          terminal = evt.terminationReason === 'interrupted' ? 'interrupted' : 'error';
          break;
        }
      }
    } catch (err) {
      log.warn('bg', 'drive-failed', { taskId: task.taskId, error: errMsg(err) });
      terminal = terminal ?? 'error';
    } finally {
      this.live.delete(task.taskId);
      slot();
      const finalStatus = terminal ?? 'done';
      this.finish({ ...task, sessionId }, cardId, finalStatus, terminalLine(finalStatus), text);
    }
  }

  private finish(
    task: BgTask,
    cardId: string | undefined,
    status: BgTaskStatus,
    progress: string,
    text: string,
  ): void {
    this.deps.store.update(task.taskId, { status, lastNode: progress, updatedAt: this.now() });
    const finalTask: BgTask = { ...task, status, lastNode: progress };
    if (cardId) {
      void this.deps
        .updateCard(task.chatId, cardId, { task: finalTask, progress, text })
        .catch(() => {});
    }
    const summary = text.trim().slice(0, 400);
    const head = `后台任务 ${task.taskId} ${terminalLine(status)}`;
    void this.deps
      .notify(task.chatId, summary ? `${head}\n\n${summary}` : head)
      .catch((err) => log.warn('bg', 'notify-failed', { taskId: task.taskId, error: errMsg(err) }));
  }
}

function terminalLine(status: BgTaskStatus): string {
  switch (status) {
    case 'done':
      return '已完成';
    case 'error':
      return '出错';
    case 'interrupted':
      return '已停止';
    default:
      return status;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
