# Codex Profile Card Implementation Plan

## Goal

Add a Feishu-first way to edit the active Codex profile from chat:

- floating-menu entry text: `Codex 设置`
- explicit command: `/codex-config`
- CardKit form for safe profile fields

## Scope

The form edits only the active profile when `agentKind` is `codex`.

Fields:

- default workspace path
- `permissions.defaultAccess`
- `permissions.maxAccess`
- Codex home mode: inherit user `CODEX_HOME`, profile-local, or custom path
- `codex.ignoreUserConfig`
- `codex.ignoreRules`

Out of scope for this pass:

- model/reasoning presets, because the current runtime schema does not expose them
- editing other profiles from the current chat
- changing app credentials or lark-cli identity, which remains under `/config` and `/account`

## Implementation Steps

1. Add failing integration tests for `/codex-config`, `Codex 设置`, and non-Codex rejection.
2. Add a Codex-specific CardKit form and result cards.
3. Add `/codex-config` command handling, validation, locked config writes, and runtime control refresh.
4. Add menu/help/README entries.
5. Run focused tests, then typecheck/build verification.
