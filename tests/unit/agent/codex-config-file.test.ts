import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readCodexModelConfig,
  updateCodexModelConfigText,
  writeCodexModelConfig,
} from '../../../src/config/codex-config-file';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex config.toml model settings', () => {
  it('updates top-level model settings without touching section values', () => {
    const next = updateCodexModelConfigText(
      [
        '# existing config',
        'model = "old-model"',
        'model_reasoning_effort = "low"',
        '',
        '[model_providers.openai]',
        'model = "provider-model"',
        '',
      ].join('\n'),
      { model: 'gpt-5.5', modelReasoningEffort: 'xhigh' },
    );

    expect(next).toMatch(/^model = "gpt-5\.5"$/m);
    expect(next).toMatch(/^model_reasoning_effort = "xhigh"$/m);
    expect(next).toContain('[model_providers.openai]\nmodel = "provider-model"');
  });

  it('creates and reads a Codex config file in the selected home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-config-file-'));
    roots.push(root);
    const configFile = join(root, 'config.toml');

    await writeCodexModelConfig(configFile, {
      model: 'gpt-5.5',
      modelReasoningEffort: 'high',
    });

    await expect(readFile(configFile, 'utf8')).resolves.toContain('model = "gpt-5.5"');
    await expect(readCodexModelConfig(configFile)).resolves.toEqual({
      model: 'gpt-5.5',
      modelReasoningEffort: 'high',
    });
  });

  it('removes model settings when values are cleared', () => {
    const next = updateCodexModelConfigText(
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n[features]\nhooks = true\n',
      { model: '', modelReasoningEffort: '' },
    );

    expect(next).not.toContain('model =');
    expect(next).not.toContain('model_reasoning_effort');
    expect(next).toContain('[features]\nhooks = true');
  });
});
