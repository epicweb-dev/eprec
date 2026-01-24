# Release process

Releases are handled by semantic-release in CI using Bun.

## Requirements

- Commit messages follow Conventional Commits. See `docs/commit-convention.md`.
- Changes land on `main`.

## CI behavior

- Workflow: `.github/workflows/release.yml`
- Installs dependencies with `bun install`.
- Runs semantic-release with `bunx`.
- Publishes source files (no build step).
- Uses npm trusted publishing with OIDC and provenance.

## Local dry run

```bash
bunx semantic-release --config release-config.cjs --dry-run
```
