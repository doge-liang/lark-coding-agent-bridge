# Repository Instructions

## Release and branch policy

- `main` is the only normal long-lived product branch and must remain releasable.
- Merging into `main` does not publish a release.
- A published release requires a version bump, an immutable `vMAJOR.MINOR.PATCH` tag on `main`, and a matching GitHub Release.
- Controlled self-update defaults to `main` and compares branch commits; it does not discover versions from GitHub Releases.
- Explicit custom upgrade branches remain supported. Do not silently rewrite them.
- Do not create a permanent `release` branch unless a separate stabilization or supported-backport train is explicitly required.
- Keep any upstream comparison remote or branch separate from the product release workflow.
- Do not delete a legacy release branch until active profiles that track it have migrated to `main`.

### Release checklist

1. Merge reviewed changes into a green `main`.
2. Choose the next semantic version and apply it consistently to version metadata.
3. Run `pnpm test`, `pnpm typecheck`, and `pnpm build` successfully.
4. Create and push the immutable `vMAJOR.MINOR.PATCH` tag from `main`.
5. Create the matching GitHub Release from that tag.
6. Verify that the GitHub Release, version tag, and configured upgrade source resolve to the intended commit.
