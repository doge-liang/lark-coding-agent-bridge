import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';

export interface UpgradeLauncherScriptInputs {
  profile: string;
  channelHome: string;
  fallbackNodePath: string;
  fallbackBridgeEntryPath: string;
}

export async function writeUpgradeLauncherScript(
  launcherFile: string,
  inputs: UpgradeLauncherScriptInputs,
): Promise<void> {
  await mkdir(dirname(launcherFile), { recursive: true });
  await writeFileAtomic(launcherFile, buildUpgradeLauncherScript(inputs), { mode: 0o700 });
}

export function buildUpgradeLauncherScript(inputs: UpgradeLauncherScriptInputs): string {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PROFILE = ${JSON.stringify(inputs.profile)};
const CHANNEL_HOME = ${JSON.stringify(inputs.channelHome)};
const FALLBACK_NODE = ${JSON.stringify(inputs.fallbackNodePath)};
const FALLBACK_BRIDGE_ENTRY = ${JSON.stringify(inputs.fallbackBridgeEntryPath)};
const rootDir = join(CHANNEL_HOME, 'profiles', PROFILE, 'upgrades');
const stateFile = join(rootDir, 'state.json');
const MAX_CAPTURED_STDERR_CHARS = 4000;

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

function writeState(state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\\n', { mode: 0o600 });
}

function childCommand(state) {
  if (state.current && state.current.path) {
    return {
      node: process.execPath,
      args: [join(state.current.path, 'bin', 'lark-channel-bridge.mjs'), 'run', '--profile', PROFILE],
    };
  }
  return { node: FALLBACK_NODE, args: [FALLBACK_BRIDGE_ENTRY, 'run', '--profile', PROFILE] };
}

function activationFailureNotification(state, message, now) {
  const pending = state.pendingActivation;
  if (!pending || !pending.notify) return undefined;
  return {
    id: pending.operationId + ':activation_failed',
    kind: 'activation_failed',
    status: state.previous ? 'rolled_back' : 'failed',
    commit: pending.commit,
    message,
    notify: pending.notify,
    createdAt: now,
  };
}

function rollbackState(state, message) {
  const now = new Date().toISOString();
  const pendingNotification = activationFailureNotification(state, message, now);
  if (!state.previous) {
    const next = { ...state };
    delete next.pendingActivation;
    if (pendingNotification) next.pendingNotification = pendingNotification;
    next.lastOperation = {
      kind: 'apply',
      status: 'failed',
      stage: 'activation',
      message,
      at: now,
    };
    writeState(next);
    return { state: next, rolledBack: false };
  }
  const next = {
    current: state.previous,
    ...(pendingNotification ? { pendingNotification } : {}),
    lastOperation: {
      kind: 'apply',
      status: 'rolled_back',
      stage: 'activation',
      message,
      at: now,
    },
  };
  writeState(next);
  return { state: next, rolledBack: true };
}

function appendCapturedStderr(current, chunk) {
  const next = current + String(chunk);
  return next.length > MAX_CAPTURED_STDERR_CHARS
    ? next.slice(next.length - MAX_CAPTURED_STDERR_CHARS)
    : next;
}

function sanitizeDiagnostic(text) {
  return String(text)
    .replace(/((?:secret|token|authorization)(?:["']?\\s*[:=]\\s*))[^\\s,}]+/gi, '$1[REDACTED]')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(-1200);
}

function childExitMessage(result, stderrTail) {
  const parts = ['child-exited-before-healthy'];
  if (result.error) parts.push('spawnError=' + sanitizeDiagnostic(result.error));
  if (result.exitCode !== undefined && result.exitCode !== null) {
    parts.push('exitCode=' + result.exitCode);
  }
  if (result.signal) parts.push('signal=' + result.signal);
  if (stderrTail) parts.push('stderr=' + sanitizeDiagnostic(stderrTail));
  return parts.join('; ');
}

function readProfileRuntimeLockMeta() {
  const metaFile = join(CHANNEL_HOME, 'registry', 'locks', 'profile', PROFILE + '.lock.meta.json');
  try {
    return JSON.parse(readFileSync(metaFile, 'utf8'));
  } catch {
    return undefined;
  }
}

function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function activationOwnedByAnotherProcess(pendingActivation, childPid) {
  const meta = readProfileRuntimeLockMeta();
  if (!meta || meta.kind !== 'profile' || meta.profile !== PROFILE) return false;
  if (typeof meta.pid !== 'number' || meta.pid === process.pid || meta.pid === childPid) return false;
  const pendingStarted = Date.parse(pendingActivation.startedAt);
  const holderStarted = Date.parse(meta.startedAt);
  if (!Number.isFinite(pendingStarted) || !Number.isFinite(holderStarted)) return false;
  if (holderStarted < pendingStarted) return false;
  return isPidAlive(meta.pid);
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', (err) => {
      finish({
        exitCode: 1,
        signal: null,
        error: err && err.message ? err.message : String(err),
      });
    });
    child.once('exit', (exitCode, signal) => {
      finish({
        exitCode: exitCode === null ? null : exitCode,
        signal: signal || null,
      });
    });
  });
}

async function runOnce() {
  const state = readState();
  const command = childCommand(state);
  const child = spawn(command.node, command.args, {
    stdio: ['inherit', 'inherit', 'pipe'],
    env: { ...process.env, LARK_CHANNEL_HOME: CHANNEL_HOME },
  });
  let stderrTail = '';
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      stderrTail = appendCapturedStderr(stderrTail, chunk);
    });
  }
  const pendingActivation = state.pendingActivation;
  let activationTimer;
  let rolledBackForTimeout = false;
  let terminatingSignal;
  if (pendingActivation) {
    const deadline = Date.parse(pendingActivation.deadlineAt);
    const waitMs = Number.isFinite(deadline) ? Math.max(1, deadline - Date.now()) : 60000;
    activationTimer = setTimeout(() => {
      const latest = readState();
      if (
        !latest.pendingActivation ||
        latest.pendingActivation.commit !== pendingActivation.commit ||
        latest.pendingActivation.operationId !== pendingActivation.operationId
      ) {
        return;
      }
      child.kill('SIGTERM');
      rolledBackForTimeout = rollbackState(latest, 'health-timeout').rolledBack === true;
    }, waitMs);
  }
  const forward = (signal) => {
    terminatingSignal = signal;
    if (activationTimer) clearTimeout(activationTimer);
    child.kill(signal);
  };
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);
  const childResult = await waitForChildExit(child);
  if (activationTimer) clearTimeout(activationTimer);
  process.removeListener('SIGINT', forward);
  process.removeListener('SIGTERM', forward);
  if (terminatingSignal) {
    process.exit(0);
  }
  if (rolledBackForTimeout) return 'retry';
  const latest = readState();
  if (pendingActivation && latest.pendingActivation) {
    if (activationOwnedByAnotherProcess(latest.pendingActivation, child.pid)) {
      process.stderr.write(
        '[upgrade] pending activation is owned by another live bridge process; leaving state unchanged\\n',
      );
      return 'handoff';
    }
    const rollbackResult = rollbackState(latest, childExitMessage(childResult, stderrTail));
    if (rollbackResult.rolledBack) return 'retry';
    process.exit(1);
  }
  const exitCode = childResult.exitCode === null || childResult.exitCode === undefined
    ? childResult.signal ? 1 : 0
    : childResult.exitCode;
  process.exit(Number(exitCode));
}

for (;;) {
  const action = await runOnce();
  if (action !== 'retry') break;
}
`;
}
