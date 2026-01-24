# Agent Guidelines

## Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
type(scope): description

[optional body]
```

**Types:**

- `feat` - New feature (triggers minor release)
- `fix` - Bug fix (triggers patch release)
- `docs` - Documentation only (no release triggered)
- `refactor` - Code change that neither fixes a bug nor adds a feature (no
  release triggered)
- `test` - Adding or updating tests (no release triggered)
- `chore` - Maintenance tasks (no release triggered)

**Breaking changes:** Add `!` after type or include `BREAKING CHANGE:` in body
(triggers major release).

**Examples:**

```
feat: add chapter selection utility
fix(ffmpeg): handle missing audio streams
docs: update pipeline documentation
feat!: change CLI argument format
```
