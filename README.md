<div align="center">
<h1>eprec</h1>

<p>Tools for processing Epic Web course recordings</p>
</div>

---

<!-- prettier-ignore-start -->
[![Build Status][build-badge]][build]
[![version][version-badge]][package]
[![downloads][downloads-badge]][npmtrends]
[![MIT License][license-badge]][license]
<!-- prettier-ignore-end -->

## Installation

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

## Whisper.cpp transcription (optional)

Install the local whisper.cpp CLI (Homebrew):

```bash
brew install whisper-cpp
```

The default small English model is downloaded on first use and cached at
`.cache/whispercpp/ggml-small.en.bin`. Replace that file (or pass
`--whisper-model-path`) to use a different model.

Enable transcription with `--enable-transcription` when running
`process-course-video.ts` to skip chapters that include "jarvis bad take" or
"bad take jarvis". If the CLI isn't on your PATH, pass `--whisper-binary-path`
with the full path to `whisper-cli`.

Customize skip phrases by repeating `--whisper-skip-phrase` (do not use
comma-separated values because phrases may include commas).

Manual test checklist:

- Run with `--enable-transcription` and confirm whisper.cpp runs locally.
- Verify a chapter containing the phrase is skipped and logged.
- Verify a normal chapter still renders and writes output.

This project was created using `bun init` in bun v1.3.1. [Bun](https://bun.com)
is a fast all-in-one JavaScript runtime.

<!-- prettier-ignore-start -->
[build-badge]: https://img.shields.io/github/actions/workflow/status/epicweb-dev/eprec/validate.yml?branch=main&logo=github&style=flat-square
[build]: https://github.com/epicweb-dev/eprec/actions?query=workflow%3Avalidate
[version-badge]: https://img.shields.io/npm/v/eprec.svg?style=flat-square
[package]: https://www.npmjs.com/package/eprec
[downloads-badge]: https://img.shields.io/npm/dm/eprec.svg?style=flat-square
[npmtrends]: https://www.npmtrends.com/eprec
[license-badge]: https://img.shields.io/npm/l/eprec.svg?style=flat-square
[license]: https://github.com/epicweb-dev/eprec/blob/main/LICENSE
<!-- prettier-ignore-end -->
