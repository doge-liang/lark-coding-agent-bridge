# Main-Branch Release Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `main` the default controlled-self-update channel and persist the repository's single-main release workflow in tests and agent-facing documentation.

**Architecture:** Keep the existing configurable upgrade branch interface, changing only the fallback/default from `release` to `main`. Preserve explicitly configured branches. Treat root `AGENTS.md` as the durable operating policy and keep the bilingual README aligned with the runtime default.

**Tech Stack:** TypeScript, Vitest, pnpm, Markdown, Git/GitHub Releases

## Global Constraints

- `main` is the only normal long-lived product branch.
- Published versions require an immutable semantic-version tag and matching GitHub Release.
- `/upgrade check` remains commit/branch based and defaults to `main`; it does not query GitHub Releases.
- Explicitly configured alternative upgrade branches remain supported.
- Existing persisted `branch: "release"` values are not silently rewritten.
- Do not delete the remote `release` branch until active profiles have migrated.

---

### Task 1: Change the controlled-self-update default

**Files:**
- Modify: `tests/unit/config/profile-schema.test.ts`
- Modify: `tests/unit/upgrade/manager.test.ts`
- Modify: `src/config/profile-schema.ts`

**Interfaces:**
- Consumes: `createDefaultProfileConfig()` and `normalizeProfileConfig()`.
- Produces: `UpgradeConfig.branch === "main"` when the field is absent or blank; explicit values such as `stable` and `release` remain unchanged.

- [ ] **Step 1: Change tests to require the new default**

Update the default profile expectation to:

```ts
expect(cfg.upgrade).toEqual({
  enabled: false,
  remote: 'origin',
  branch: 'main',
  requireTests: false,
  healthTimeoutMs: 60_000,
  retainReleases: 3,
});
```

Add a normalization assertion using `upgrade: { branch: '   ' }` and expect
`cfg.upgrade.branch` to equal `main`. Keep the existing `stable` normalization
test and `release` serialization test to prove explicit branches are preserved.

In `manager.test.ts`, rename the default-branch test to `checks configured main
branch` and change the expected refs to:

```ts
'refs/heads/main:refs/remotes/origin/main'
'refs/remotes/origin/main'
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
pnpm vitest run tests/unit/config/profile-schema.test.ts tests/unit/upgrade/manager.test.ts
```

Expected: failures show the runtime still defaults to `release`.

- [ ] **Step 3: Implement the minimal default change**

Change both fallbacks in `src/config/profile-schema.ts`:

```ts
const branch = nonEmptyString(raw.branch, 'main');
```

and:

```ts
function defaultUpgradeConfig(): UpgradeConfig {
  return {
    enabled: false,
    remote: 'origin',
    branch: 'main',
    requireTests: false,
    healthTimeoutMs: 60_000,
    retainReleases: 3,
  };
}
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run the Step 2 command again. Expected: all selected tests pass.

- [ ] **Step 5: Commit the runtime behavior**

```bash
git add src/config/profile-schema.ts tests/unit/config/profile-schema.test.ts tests/unit/upgrade/manager.test.ts
git commit -m "fix: track main for controlled self-update"
```

### Task 2: Persist and document the release policy

**Files:**
- Create: `AGENTS.md`
- Create: `tests/unit/docs/release-policy-contract.test.ts`
- Modify: `tests/unit/docs/readme-contract.test.ts`
- Modify: `README.md`
- Modify: `README.zh.md`

**Interfaces:**
- Consumes: the runtime default from Task 1.
- Produces: durable agent instructions and bilingual operator documentation that describe `main` as the default upgrade source.

- [ ] **Step 1: Write documentation contract tests**

Create `release-policy-contract.test.ts`:

```ts
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
});
```

In `readme-contract.test.ts`, replace `release branch` and `release 分支` with
`main branch` and `main 分支`.

- [ ] **Step 2: Run documentation tests and verify they fail**

```bash
pnpm vitest run tests/unit/docs/readme-contract.test.ts tests/unit/docs/release-policy-contract.test.ts
```

Expected: `AGENTS.md` is missing and the README still describes a release branch.

- [ ] **Step 3: Add the durable root policy**

Create root `AGENTS.md` with these exact policy points:

```md
## Release and branch policy

- `main` is the only normal long-lived product branch and must remain releasable.
- Merging into `main` does not publish a release.
- A published release requires a version bump, an immutable `vMAJOR.MINOR.PATCH` tag on `main`, and a matching GitHub Release.
- Controlled self-update defaults to `main` and compares branch commits; it does not discover versions from GitHub Releases.
- Explicit custom upgrade branches remain supported. Do not silently rewrite them.
- Do not create a permanent `release` branch unless a separate stabilization or supported-backport train is explicitly required.
- Keep any upstream comparison remote or branch separate from the product release workflow.
```

Include the six-step release checklist from the approved design.

- [ ] **Step 4: Align the bilingual README**

Change the sample configuration to `"branch": "main"`. Describe self-update as
tracking the configured/default `main` branch and change command-table wording
to `configured main branch` / `配置的 main 分支`. Preserve the term `release`
when it refers to staged release directories or rollback state rather than a
Git branch.

- [ ] **Step 5: Run documentation tests and verify they pass**

Run the Step 2 command again. Expected: all selected tests pass.

- [ ] **Step 6: Commit documentation and contracts**

```bash
git add AGENTS.md README.md README.zh.md tests/unit/docs/readme-contract.test.ts tests/unit/docs/release-policy-contract.test.ts
git commit -m "docs: persist main branch release workflow"
```

### Task 3: Verify the complete change

**Files:**
- Verify only; modify earlier files only if verification exposes a direct regression.

**Interfaces:**
- Consumes: runtime and documentation changes from Tasks 1 and 2.
- Produces: a clean, buildable branch ready for review.

- [ ] **Step 1: Scan active source and user documentation for stale defaults**

```bash
rg -n "branch: 'release'|\"branch\": \"release\"|release-branch deployments|configured release branch|配置的 release 分支" src tests README.md README.zh.md AGENTS.md
```

Expected: only intentional explicit-branch compatibility tests may remain.

- [ ] **Step 2: Run repository verification**

```bash
git diff --check
pnpm test
pnpm typecheck
pnpm build
```

Expected: all commands exit successfully.

- [ ] **Step 3: Inspect the final branch state**

```bash
git status --short
git log --oneline --decorate -5
```

Expected: clean worktree with the design, runtime, and documentation commits on
`chore/main-release-policy`.
