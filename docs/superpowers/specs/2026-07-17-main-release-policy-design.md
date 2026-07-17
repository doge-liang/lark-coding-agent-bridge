# Main-Branch Release Policy Design

## Goal

Adopt `main` as this repository's single canonical development and release
branch. Use immutable semantic-version tags and GitHub Releases to identify
published versions, and make controlled self-update track `main` by default.

This policy is intended for the repository's current operating model: one
maintained product line, owner-led development, and no separate stabilization
or backport train.

## Approaches Considered

1. **Single `main` branch plus version tags and GitHub Releases (selected).**
   This keeps development, upgrade checks, and published source aligned while
   preserving exact release points through tags.
2. **A permanent `release` branch.** This can support a delayed production
   channel, but it duplicates state and has already allowed `main` and
   `release` to drift.
3. **Versioned release branches such as `release/0.3`.** These are useful for
   parallel maintenance and backports, but the repository does not currently
   maintain multiple supported versions.

## Branch and Release Rules

- `main` is the only long-lived product branch and must remain releasable.
- Feature and fix branches merge into `main` through reviewed pull requests.
- A published version is an immutable `vMAJOR.MINOR.PATCH` tag on `main` plus a
  corresponding GitHub Release.
- Merging to `main` is not, by itself, a published release. A release also
  requires the version bump, tag, and GitHub Release.
- A permanent `release` branch is not part of the normal workflow. It may only
  be introduced later for an explicit stabilization or supported-backport
  requirement.
- Upstream comparison branches or remotes are reference inputs only; they are
  not product release branches.

## Controlled Self-Update

- New or incomplete profile configurations default `upgrade.branch` to
  `main`.
- Explicit alternative branches remain supported for operators who configure
  them deliberately; normalization must not silently rewrite such values.
- Existing profiles that already persist `branch: "release"` require an
  explicit operational migration to `branch: "main"`. This avoids treating an
  intentional custom branch as legacy data.
- `/upgrade check` continues to compare branch commits. It does not infer the
  latest semantic version from GitHub Releases.
- The legacy `release` branch should be retired only after active profiles have
  been migrated, so older running installations retain an upgrade path during
  the transition.

## Repository Documentation

A root `AGENTS.md` will persist the rules above for future agent sessions. It
will also define the release checklist:

1. Merge reviewed changes into a green `main`.
2. Choose and apply the next semantic version consistently.
3. Run the required verification suite.
4. Create and push the immutable version tag from `main`.
5. Create the matching GitHub Release.
6. Verify that the release and upgrade source resolve to the intended commit.

README self-update documentation and command descriptions will use `main`
rather than `release` as the default channel.

## Verification

- Update configuration unit tests to assert a `main` default while preserving
  explicit branch values.
- Update documentation contract tests and upgrade terminology.
- Run focused configuration, upgrade, and documentation tests.
- Run the repository's typecheck and full test suite before claiming the
  migration complete.

## Rollout

The code and documentation changes will ship from a branch based on the latest
`origin/main`. After merge, active profile configuration can be changed to
`main`; then a new semantic version tag and GitHub Release can be published.
The legacy `release` branch can be removed after that transition is verified.
