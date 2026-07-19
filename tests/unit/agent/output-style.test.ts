import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadActiveOutputStyleAppend } from '../../../src/agent/claude/output-style.js';

const cleanups: Array<() => Promise<void>> = [];
let prevConfigDir: string | undefined;

async function makeConfig(settings: unknown, styles: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ostyle-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  if (settings !== undefined) {
    await writeFile(join(root, 'settings.json'), JSON.stringify(settings), 'utf8');
  }
  if (Object.keys(styles).length > 0) {
    await mkdir(join(root, 'output-styles'), { recursive: true });
    for (const [name, content] of Object.entries(styles)) {
      await writeFile(join(root, 'output-styles', name), content, 'utf8');
    }
  }
  process.env.CLAUDE_CONFIG_DIR = root;
  return root;
}

const STYLE_FILE = `---
name: Formal Scholar
description: whatever
keep-coding-instructions: true
---

# Global style

Write formally.`;

describe('loadActiveOutputStyleAppend', () => {
  beforeEach(() => {
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  });
  afterEach(async () => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  it('matches the style by frontmatter name and appends the body with frontmatter stripped', async () => {
    await makeConfig({ outputStyle: 'Formal Scholar' }, { 'formal-scholar.md': STYLE_FILE });
    const out = loadActiveOutputStyleAppend();
    expect(out).toBe('\n\n# Global style\n\nWrite formally.');
    expect(out).not.toContain('keep-coding-instructions');
  });

  it('falls back to filename slug when no frontmatter name matches', async () => {
    const noName = STYLE_FILE.replace('name: Formal Scholar\n', '');
    await makeConfig({ outputStyle: 'formal-scholar' }, { 'formal-scholar.md': noName });
    expect(loadActiveOutputStyleAppend()).toContain('Write formally.');
  });

  it('returns empty string when no outputStyle is configured', async () => {
    await makeConfig({ model: 'fable' }, { 'formal-scholar.md': STYLE_FILE });
    expect(loadActiveOutputStyleAppend()).toBe('');
  });

  it('returns empty string for a built-in style with no file on disk', async () => {
    await makeConfig({ outputStyle: 'Explanatory' });
    expect(loadActiveOutputStyleAppend()).toBe('');
  });

  it('returns empty string when settings.json is missing', async () => {
    await makeConfig(undefined);
    expect(loadActiveOutputStyleAppend()).toBe('');
  });

  it('never throws on malformed settings.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ostyle-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'settings.json'), '{ not json', 'utf8');
    process.env.CLAUDE_CONFIG_DIR = root;
    expect(loadActiveOutputStyleAppend()).toBe('');
  });
});
