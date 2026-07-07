import { describe, expect, it } from 'vitest';
import {
  accessToClaudePermissionMode,
  normalizePermissions,
} from '../../../src/config/permissions.js';

describe('auto permission mode', () => {
  it('maps full access to auto by default', () => {
    expect(accessToClaudePermissionMode('full')).toBe('auto');
  });

  it('keeps read-only and workspace mappings unchanged', () => {
    expect(accessToClaudePermissionMode('read-only')).toBe('plan');
    expect(accessToClaudePermissionMode('workspace')).toBe('acceptEdits');
  });

  it('honors an explicit bypassPermissions override under full access', () => {
    expect(
      accessToClaudePermissionMode('full', {
        defaultAccess: 'full',
        maxAccess: 'full',
        claude: { permissionMode: 'bypassPermissions' },
      }),
    ).toBe('bypassPermissions');
  });

  it('accepts auto as an explicit permissionMode override', () => {
    const { permissions } = normalizePermissions({
      permissions: { defaultAccess: 'full', maxAccess: 'full', claude: { permissionMode: 'auto' } },
    });
    expect(permissions.claude?.permissionMode).toBe('auto');
  });

  it('rejects auto override when maxAccess is below full', () => {
    expect(() =>
      normalizePermissions({
        permissions: { defaultAccess: 'workspace', maxAccess: 'workspace', claude: { permissionMode: 'auto' } },
      }),
    ).toThrow(/cannot exceed maxAccess/);
  });
});
