# Release process

Releases are handled by semantic-release in CI using Bun.

## Requirements

- Commit messages follow Conventional Commits. See `.cursor/rules/commit-convention.mdc`.
- Changes land on `main`.

## CI behavior

- Workflow: `.github/workflows/validate.yml`
- Runs `bun run validate` in the main job.
- Installs dependencies with `bun install`.
- Runs semantic-release via the GitHub Action (default config).
- Publishes source files (no build step).
- Uses npm trusted publishing with OIDC and provenance.
- Release branches:
  - `main`, `next`, `next-major`
  - `beta` (prerelease), `alpha` (prerelease)
  - maintenance: `+([0-9])?(.{+([0-9]),x}).x`

## Local dry run

```bash
npx semantic-release --dry-run
```
