import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('release policy contract', () => {
  it('persists the single-main release workflow for future agents', async () => {
    const policy = await readFile(new URL('../../../AGENTS.md', import.meta.url), 'utf8');

    expect(policy).toContain('`main` is the only normal long-lived product branch');
    expect(policy).toContain('immutable `vMAJOR.MINOR.PATCH` tag');
    expect(policy).toContain('matching GitHub Release');
    expect(policy).toContain('defaults to `main`');
    expect(policy).toContain('does not publish a release');
  });

  it('describes the upgrade source as a configurable branch', async () => {
    const configCard = await readFile(new URL('../../../src/card/config-card.ts', import.meta.url), 'utf8');

    expect(configCard).toContain('获取配置分支最新 commit');
    expect(configCard).not.toContain('获取 release 分支最新 commit');
  });
});
