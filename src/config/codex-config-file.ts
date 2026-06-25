import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CodexModelConfig {
  model: string;
  modelReasoningEffort: string;
}

const MODEL_KEY = 'model';
const REASONING_KEY = 'model_reasoning_effort';
const VALID_REASONING_EFFORTS = new Set(['', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export async function readCodexModelConfig(configFile: string): Promise<CodexModelConfig> {
  let content = '';
  try {
    content = await readFile(configFile, 'utf8');
  } catch (err) {
    if (isNodeErrno(err, 'ENOENT')) return { model: '', modelReasoningEffort: '' };
    throw err;
  }
  return readCodexModelConfigText(content);
}

export function readCodexModelConfigText(content: string): CodexModelConfig {
  const config: CodexModelConfig = { model: '', modelReasoningEffort: '' };
  for (const line of content.split(/\r?\n/)) {
    if (isTomlTableHeader(line)) break;
    const match = line.match(/^\s*(model|model_reasoning_effort)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    const value = parseTomlStringish(match[2] ?? '');
    if (match[1] === MODEL_KEY) config.model = value;
    if (match[1] === REASONING_KEY) config.modelReasoningEffort = value;
  }
  return config;
}

export async function writeCodexModelConfig(
  configFile: string,
  config: CodexModelConfig,
): Promise<void> {
  let current = '';
  try {
    current = await readFile(configFile, 'utf8');
  } catch (err) {
    if (!isNodeErrno(err, 'ENOENT')) throw err;
  }

  const next = updateCodexModelConfigText(current, config);
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, next, { encoding: 'utf8', mode: 0o600 });
}

export function updateCodexModelConfigText(
  content: string,
  config: CodexModelConfig,
): string {
  const model = normalizeModel(config.model);
  const modelReasoningEffort = normalizeReasoningEffort(config.modelReasoningEffort);
  const wanted = new Map<string, string>([
    [MODEL_KEY, model],
    [REASONING_KEY, modelReasoningEffort],
  ]);
  const seen = new Set<string>();
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const sourceLines = content ? content.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  let inTopLevel = true;
  let lines: string[] = [];

  for (const line of sourceLines) {
    if (isTomlTableHeader(line)) inTopLevel = false;
    const match = inTopLevel ? line.match(/^(\s*)(model|model_reasoning_effort)\s*=/) : null;
    if (!match) {
      lines.push(line);
      continue;
    }

    const key = match[2] ?? '';
    seen.add(key);
    const value = wanted.get(key) ?? '';
    if (value) lines.push(`${key} = ${tomlString(value)}`);
  }

  const additions = [MODEL_KEY, REASONING_KEY]
    .filter((key) => !seen.has(key) && wanted.get(key))
    .map((key) => `${key} = ${tomlString(wanted.get(key) ?? '')}`);

  if (additions.length > 0) {
    lines = insertTopLevelLines(lines, additions);
  }

  return lines.length > 0 ? `${lines.join(newline)}${newline}` : '';
}

function insertTopLevelLines(lines: string[], additions: string[]): string[] {
  const firstTableIndex = lines.findIndex(isTomlTableHeader);
  if (firstTableIndex >= 0) {
    const before = lines.slice(0, firstTableIndex);
    const after = lines.slice(firstTableIndex);
    if (before.length > 0 && before[before.length - 1]?.trim() !== '') before.push('');
    const block = [...additions];
    if (after.length > 0 && after[0]?.trim() !== '') block.push('');
    return [...before, ...block, ...after];
  }

  if (lines.length > 0 && lines[lines.length - 1]?.trim() !== '') lines.push('');
  return [...lines, ...additions];
}

function normalizeModel(value: string): string {
  const model = String(value ?? '').trim();
  if (/[\r\n]/.test(model)) throw new Error('model 不能包含换行。');
  return model;
}

function normalizeReasoningEffort(value: string): string {
  const effort = String(value ?? '').trim();
  const normalized = effort === 'default' ? '' : effort;
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error('model_reasoning_effort 只支持 minimal/low/medium/high/xhigh，或留空使用默认。');
  }
  return normalized;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function parseTomlStringish(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:\\.|[^"\\])*)"/);
    if (!match) return '';
    return JSON.parse(`"${match[1]}"`) as string;
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? '' : value.slice(1, end);
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function isTomlTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

function isNodeErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === code);
}
