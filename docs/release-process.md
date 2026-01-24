# Release process

Releases are handled by semantic-release in CI using Bun.

## Requirements

- Commit messages follow Conventional Commits. See `.cursor/rules/commit-convention.mdc`.
- Changes land on `main`.

## CI behavior

- Workflow: `.github/workflows/release.yml`
- Installs dependencies with `bun install`.
- Runs semantic-release with `npx` (Node-only tool).
- Publishes source files (no build step).
- Uses npm trusted publishing with OIDC and provenance.

## Local dry run

```bash
npx semantic-release --dry-run
```
