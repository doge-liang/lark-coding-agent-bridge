# Command Alias Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the exact `/update apply` alias and standardize the Chinese new-session alias on `新会话`.

**Architecture:** Continue using the existing exact-match `commandAliases` normalization before parsing. Both surviving aliases resolve to canonical commands, so the current handlers retain sole ownership of permissions, chat-mode checks, acknowledgements, session clearing, upgrade activation, and restart behavior.

**Tech Stack:** TypeScript, Vitest, pnpm, Markdown documentation

## Global Constraints

- Only `/update apply` maps to `/upgrade apply`; other `/update` forms remain unsupported.
- Keep `新会话` → `/new` and remove `新对话` everywhere it is presented as a command alias.
- Do not add handlers, permission rules, callback paths, dependencies, or upgrade logic.
- Use test-first red-green cycles for every behavior change.

---

### Task 1: Add the exact update-apply alias

**Files:**
- Modify: `tests/integration/commands/upgrade-command.test.ts`
- Modify: `src/commands/index.ts:219-234`

**Interfaces:**
- Consumes: `tryHandleCommand(ctx: CommandContext): Promise<boolean>` and the existing `commandAliases: Map<string, string>`.
- Produces: exact normalization of `/update apply` to `/upgrade apply`; no exported API changes.

- [ ] **Step 1: Write the failing integration test**

Add this case inside `describe('Lark upgrade command', ...)`:

```ts
it('maps only exact /update apply to the canonical upgrade command', async () => {
  const h = await createHarness();
  h.upgrade.apply.mockResolvedValue('已切换到 `abc123`，正在重启。');

  await expect(h.run('/update apply')).resolves.toBe(true);
  expect(h.upgrade.apply).toHaveBeenCalledTimes(1);
  expect(lastMarkdown(h.channel)).toContain('abc123');

  await expect(h.run('/update check')).resolves.toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run tests/integration/commands/upgrade-command.test.ts -t "maps only exact /update apply" --reporter=verbose
```

Expected: FAIL because `h.run('/update apply')` currently resolves to `false`.

- [ ] **Step 3: Add the minimal alias mapping**

Add one entry to `commandAliases` in `src/commands/index.ts`:

```ts
['/update apply', '/upgrade apply'],
```

Do not add `/update` to `handlers` or `ADMIN_COMMANDS`; normalization must reach the existing canonical `/upgrade` checks.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/integration/commands/upgrade-command.test.ts -t "maps only exact /update apply" --reporter=verbose
```

Expected: PASS; `apply` is called once and `/update check` remains unhandled.

- [ ] **Step 5: Commit the behavior**

```bash
git add src/commands/index.ts tests/integration/commands/upgrade-command.test.ts
git commit -m "feat: add update apply command alias"
```

---

### Task 2: Remove the old new-session label

**Files:**
- Modify: `tests/integration/commands/claude-commands.test.ts:155-176`
- Modify: `src/commands/index.ts:219-234`
- Modify: `src/card/templates.ts:329-350`

**Interfaces:**
- Consumes: the same exact-match `commandAliases` normalization and existing `/new` handler.
- Produces: `新会话` remains a bridge command; `新对话` becomes ordinary unhandled text; the menu help card presents only `新会话`.

- [ ] **Step 1: Change the floating-menu test to express the desired labels**

Replace the `新对话` assertion and strengthen the captured menu assertions:

```ts
expect(menu).toContain('新会话');
expect(menu).not.toContain('新对话');

await expect(h.run('新会话')).resolves.toBe(true);
expect(lastMarkdown(h.channel)).toBe('已开始新会话。');

await expect(h.run('新对话')).resolves.toBe(false);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run tests/integration/commands/claude-commands.test.ts -t "handles floating menu text aliases" --reporter=verbose
```

Expected: FAIL because the current menu still contains `新对话` and the old label is still handled.

- [ ] **Step 3: Remove the obsolete alias and menu copy**

Delete this entry from `commandAliases`:

```ts
['新对话', '/new'],
```

Replace the two new-session menu lines in `src/card/templates.ts`:

```ts
'- `新对话` → `/new`',
'- `新会话` 也会映射到 `/new`',
```

with the single canonical label:

```ts
'- `新会话` → `/new`',
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/integration/commands/claude-commands.test.ts -t "handles floating menu text aliases" --reporter=verbose
```

Expected: PASS; the menu contains only `新会话`, and `新对话` returns `false` from command routing.

- [ ] **Step 5: Commit the behavior**

```bash
git add src/commands/index.ts src/card/templates.ts tests/integration/commands/claude-commands.test.ts
git commit -m "fix: standardize new session menu label"
```

---

### Task 3: Align the user documentation

**Files:**
- Modify: `tests/unit/docs/readme-contract.test.ts`
- Modify: `README.md:168-218`
- Modify: `README.zh.md:168-218`

**Interfaces:**
- Consumes: the command behavior completed in Tasks 1 and 2.
- Produces: English and Chinese documentation that lists the exact update alias and only the canonical `新会话` menu label.

- [ ] **Step 1: Write the failing documentation contract**

Add a test to `tests/unit/docs/readme-contract.test.ts`:

```ts
it('documents only the supported command aliases', async () => {
  const docs = await readDocs();

  expect(docs).toContain('`/update apply` | Exact alias for `/upgrade apply`');
  expect(docs).toContain('`/update apply` | `/upgrade apply` 的精确别名');
  expect(docs).toContain('| `新会话` | `/new` |');
  expect(docs).not.toContain('| `新对话` | `/new` |');
});
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/docs/readme-contract.test.ts -t "documents only the supported command aliases" --reporter=verbose
```

Expected: FAIL because neither README documents the new exact alias and both still list `新对话`.

- [ ] **Step 3: Update both README command tables**

In `README.md`, add directly after the `/upgrade` row:

```md
| `/update apply` | Exact alias for `/upgrade apply` |
```

In `README.zh.md`, add directly after the `/upgrade` row:

```md
| `/update apply` | `/upgrade apply` 的精确别名 |
```

Delete this row from both floating-menu tables:

```md
| `新对话` | `/new` |
```

Keep the existing `新会话` row unchanged.

- [ ] **Step 4: Run the documentation test and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/unit/docs/readme-contract.test.ts -t "documents only the supported command aliases" --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Commit the documentation**

```bash
git add README.md README.zh.md tests/unit/docs/readme-contract.test.ts
git commit -m "docs: align command aliases"
```

---

### Task 4: Verify the integrated change

**Files:**
- Verify only; no planned file changes.

**Interfaces:**
- Consumes: all behavior and documentation from Tasks 1-3.
- Produces: fresh evidence that the branch is release-ready.

- [ ] **Step 1: Run both focused command suites**

```bash
pnpm exec vitest run tests/integration/commands/upgrade-command.test.ts tests/integration/commands/claude-commands.test.ts tests/unit/docs/readme-contract.test.ts --reporter=dot
```

Expected: all selected files and tests PASS.

- [ ] **Step 2: Run complete local CI**

```bash
pnpm ci:local
```

Expected: `git diff --check`, the full Vitest suite, TypeScript typecheck, and the production build all exit successfully.

- [ ] **Step 3: Inspect final scope**

```bash
git status -sb
git diff --check origin/release...HEAD
git log --oneline --decorate origin/release..HEAD
```

Expected: only the approved design, plan, alias behavior, tests, help copy, and README changes are present; the worktree is clean.
