# @epic-web/recording

A Bun-based CLI for processing recorded course videos into chapter files.

Full usage docs live in `docs/readme.md`.

## Install

```bash
bun add -g @epic-web/recording
```

## Usage

```bash
eprec "/path/to/input.mp4" "/path/to/output" --enable-transcription
```

## Development

```bash
bun install
```

## Whisper.cpp transcription (optional)

Install the local whisper.cpp CLI (Homebrew):

```bash
brew install whisper-cpp
```

The default small English model is downloaded on first use and cached at
`.cache/whispercpp/ggml-small.en.bin`. Replace that file (or pass
`--whisper-model-path`) to use a different model.

Enable transcription with `--enable-transcription` when running `eprec`
to skip chapters that include "jarvis bad take"
or "bad take jarvis". If the CLI isn't on your PATH, pass
`--whisper-binary-path` with the full path to `whisper-cli`.

Customize skip phrases by repeating `--whisper-skip-phrase` (do not use
comma-separated values because phrases may include commas).

Manual test checklist:
- Run with `--enable-transcription` and confirm whisper.cpp runs locally.
- Verify a chapter containing the phrase is skipped and logged.
- Verify a normal chapter still renders and writes output.

## Releases and commit messages

Releases are automated with semantic-release. Commit messages must follow
Conventional Commits so versions and changelogs are generated correctly.
See `docs/commit-convention.md` and `docs/release-process.md`.

This project was created using `bun init` in bun v1.3.1. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
