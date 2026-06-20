import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBridgeRootFromEntry } from '../../../src/upgrade/command-service';

describe('resolveBridgeRootFromEntry', () => {
  it('resolves package roots from source, dist, and bin entry paths', () => {
    const root = join('/', 'repo');

    expect(resolveBridgeRootFromEntry(join(root, 'src', 'upgrade', 'command-service.ts'))).toBe(root);
    expect(resolveBridgeRootFromEntry(join(root, 'src', 'cli', 'index.ts'))).toBe(root);
    expect(resolveBridgeRootFromEntry(join(root, 'dist', 'cli.js'))).toBe(root);
    expect(resolveBridgeRootFromEntry(join(root, 'bin', 'lark-channel-bridge.mjs'))).toBe(root);
  });
});
