# Self-Update Design

Date: 2026-06-20

## Summary

This design adds a controlled self-update path for the bridge so an owner or
admin can upgrade a running profile from Feishu/Lark without SSH access. The
update mechanism tracks a trusted `release` branch, verifies a staged build,
switches versions atomically, and uses a stable launcher to roll back
automatically if the new version fails to become healthy.

The bridge must not expose arbitrary shell update commands through the agent.
`/upgrade` is a built-in bridge command with a small, auditable workflow.

## Decisions

- Upgrade source: configured `origin/release`.
- Verification default: `pnpm typecheck && pnpm build`.
- Optional stronger verification: `pnpm test` when profile config enables it.
- Command access: owner/admin only, and only in direct messages.
- First implementation route: stable profile-local launcher plus pending
  activation and automatic rollback.
- Naming direction: keep the repository for now, but move package/bin naming
  toward the fork's own identity in a later rename step.

## Non-Goals

- No arbitrary `/upgrade apply <url>` or `/upgrade apply <ref>`.
- No group, topic, comment, or card-callback upgrade execution.
- No in-place mutation of the currently running release directory.
- No dependence on symlinks for correctness; Windows must work.
- No CI-built artifact requirement in the first version.

## Command Surface

`/upgrade status`

Shows local update state without network access:

- current commit and release path
- previous commit, when available
- configured remote and branch
- verification mode
- pending activation state
- last operation summary and log path

`/upgrade check`

Fetches the configured remote and compares the current commit with
`origin/release`. If an update exists, it reports the target commit, title,
author, date, and verification commands that `apply` will run.

`/upgrade apply`

Applies the newest commit reachable from the configured `origin/release`.
It does not accept user-provided refs. It stages the target, verifies it,
records pending activation, switches `current` to the new release, and asks the
OS service manager to restart the profile.

`/upgrade rollback`

Switches `current` back to `previous` and restarts the service. This is a
manual convenience for reverting a healthy but undesirable release. Startup
failure rollback is handled by the launcher automatically.

All subcommands are denied unless the sender is owner/admin and the chat mode
is `p2p`.

## Runtime Layout

Per profile:

```text
~/.lark-channel/profiles/<profile>/upgrades/
  launcher.mjs
  state.json
  state.lock
  releases/<commit>/
  staging/<operation-id>/
  logs/<operation-id>.log
```

`state.json` is the source of truth:

```json
{
  "current": {
    "commit": "abc123",
    "path": ".../releases/abc123",
    "activatedAt": "2026-06-20T19:00:00.000Z"
  },
  "previous": {
    "commit": "def456",
    "path": ".../releases/def456"
  },
  "pendingActivation": {
    "commit": "abc123",
    "startedAt": "2026-06-20T19:01:00.000Z",
    "deadlineAt": "2026-06-20T19:02:00.000Z"
  },
  "lastOperation": {
    "kind": "apply",
    "status": "ok",
    "stage": "restart",
    "message": "restart requested",
    "logPath": ".../logs/op-123.log"
  }
}
```

Writes to `state.json` use the existing atomic-write pattern and a profile-local
lock. The design does not require `current` or `previous` symlinks; those may be
added later as operator conveniences.

## Profile Config

The upgrade policy lives in the profile config so multiple bot profiles on the
same host can have different update behavior.

```json
{
  "upgrade": {
    "enabled": true,
    "remote": "origin",
    "branch": "release",
    "requireTests": false,
    "healthTimeoutMs": 60000,
    "retainReleases": 3
  }
}
```

The first version reads this config but does not provide chat commands to edit
it. That keeps the chat command surface narrow.

## Apply Flow

1. Acquire the upgrade lock for the profile.
2. Confirm the command is owner/admin p2p.
3. Confirm upgrades are enabled for the profile.
4. Fetch the configured remote.
5. Resolve the configured branch to a commit.
6. Confirm the target commit is reachable from the configured branch.
7. Create `staging/<operation-id>/`.
8. Materialize the target tree into staging.
9. Run `pnpm install --frozen-lockfile`.
10. Run `pnpm typecheck`.
11. Run `pnpm build`.
12. Run `pnpm test` when `requireTests` is true.
13. Move staging to `releases/<commit>/`.
14. Update `state.json`: set `previous` to old `current`, set `current` to the
    new release, and write `pendingActivation`.
15. Ask the existing service adapter to restart the profile.
16. Reply that the switch was staged and restart was requested.

If any step before state switch fails, `current` is unchanged. The user receives
the failed stage and log path.

## Launcher Flow

The OS service definition points to `launcher.mjs`, not directly to a release's
CLI entry. The launcher:

1. Reads profile upgrade state.
2. Starts `state.current.path/bin/<bridge-bin> run --profile <profile>`.
3. If no activation is pending, it lets the child process run normally.
4. If activation is pending, it waits for a healthy startup signal.
5. Healthy means the bridge completes `startChannel()`, obtains bot identity,
   and updates the process registry with `botName`.
6. If the child exits early or health times out, the launcher atomically restores
   `current` from `previous`, marks the operation `rolled_back`, and starts the
   previous release.
7. If health succeeds, the launcher clears `pendingActivation` and marks the
   new release active.

The default health timeout is 60 seconds. This is intentionally based on the bot
becoming reachable, not merely on the Node process staying alive.

## Service Integration

The existing launchd, systemd, and Windows Task Scheduler adapters stay as the
restart mechanism. Their service definitions change from:

```text
node <bridge-entry> run --profile <profile>
```

to:

```text
node <profile-upgrades>/launcher.mjs --profile <profile>
```

Service install/start remains responsible for first-run setup. When the launcher
does not yet have an upgrade state, it can bootstrap `current` from the installed
CLI path that created the service.

## Security Boundaries

- Upgrade commands are stricter than ordinary admin commands: p2p only.
- The remote and branch are config values, not chat input.
- The target commit must resolve from the trusted configured branch.
- Verification happens before `current` changes.
- The live release directory is never modified in place.
- Logs should redact secrets and avoid echoing app credentials.
- Agent-generated shell commands are not part of the upgrade authority.

## Error Handling

- Fetch failure: report network/source failure; do not switch.
- Missing branch: report untrusted or unavailable source; do not switch.
- Dirty or invalid staging tree: remove staging; do not switch.
- Install/build/typecheck/test failure: report failed stage and log path; do not
  switch.
- Restart request failure: keep the new `current` with pending activation and
  report the service-manager error. A later manual restart can still activate
  or roll back through the launcher.
- Startup health timeout: launcher rolls back to `previous`.
- Missing `previous` during failed activation: launcher marks activation failed
  and exits with an explicit error because it has no safe rollback target.

## Release Retention

After a successful activation, the manager may remove old release directories
beyond `retainReleases`, while always preserving `current`, `previous`, and any
release referenced by `pendingActivation`.

## Tests

Unit tests:

- owner/admin p2p can run `/upgrade check`.
- group, topic, comment, and card callback contexts reject `/upgrade`.
- non-admin p2p rejects `/upgrade`.
- `apply` verification failure does not update `current`.
- `apply` verification success writes `pendingActivation` and requests restart.
- `apply` rejects user-supplied refs.
- launcher clears pending activation after healthy registry signal.
- launcher rolls back after health timeout.
- launcher rolls back after early child exit.
- service definitions point to launcher.
- config defaults keep tests optional and health timeout at 60 seconds.

Integration tests:

- staged release can be applied from a local git remote branch.
- failed build logs are surfaced and current release remains unchanged.
- restart request uses the existing service adapter.
- rollback returns to the previous release and requests restart.

## Rollout

Phase 1 implements the manager, state model, launcher, command surface, and
tests described above.

Phase 2 can add CI-built artifacts, signed release metadata, richer status
cards, and chat-configurable upgrade preferences if operational experience shows
they are worth the extra surface area.
