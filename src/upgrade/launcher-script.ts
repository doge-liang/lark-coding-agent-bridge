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

function rollbackState(state, message) {
  if (!state.previous) {
    const next = { ...state };
    delete next.pendingActivation;
    next.lastOperation = {
      kind: 'apply',
      status: 'failed',
      stage: 'activation',
      message,
      at: new Date().toISOString(),
    };
    writeState(next);
    return next;
  }
  const next = {
    current: state.previous,
    lastOperation: {
      kind: 'apply',
      status: 'rolled_back',
      stage: 'activation',
      message,
      at: new Date().toISOString(),
    },
  };
  writeState(next);
  return next;
}

async function runOnce() {
  const state = readState();
  const command = childCommand(state);
  const child = spawn(command.node, command.args, {
    stdio: 'inherit',
    env: { ...process.env, LARK_CHANNEL_HOME: CHANNEL_HOME },
  });
  const pendingActivation = state.pendingActivation;
  let activationTimer;
  let rolledBackForTimeout = false;
  if (pendingActivation) {
    const deadline = Date.parse(pendingActivation.deadlineAt);
    const waitMs = Number.isFinite(deadline) ? Math.max(1, deadline - Date.now()) : 60000;
    activationTimer = setTimeout(() => {
      child.kill('SIGTERM');
      rollbackState(readState(), 'health-timeout');
      rolledBackForTimeout = true;
    }, waitMs);
  }
  const forward = (signal) => child.kill(signal);
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);
  const code = await new Promise((resolve) => child.on('exit', (exitCode) => resolve(exitCode ?? 1)));
  if (activationTimer) clearTimeout(activationTimer);
  process.removeListener('SIGINT', forward);
  process.removeListener('SIGTERM', forward);
  if (rolledBackForTimeout) return 'retry';
  const latest = readState();
  if (pendingActivation && latest.pendingActivation) {
    rollbackState(latest, 'child-exited-before-healthy');
    return 'retry';
  }
  process.exit(Number(code));
}

for (;;) {
  const action = await runOnce();
  if (action !== 'retry') break;
}
`;
}
