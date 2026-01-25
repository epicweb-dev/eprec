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

## Overview

A Bun-based CLI that processes recorded course videos by splitting chapter
markers into separate files, trimming silence at the start/end, and optionally
removing spoken "Jarvis" command windows via transcript timestamps refined with
audio-based silence detection.

## Requirements

- **Bun** - runtime and package manager
- **ffmpeg + ffprobe** - must be available on PATH
- **whisper-cli** _(optional)_ - from
  [whisper.cpp](https://github.com/ggerganov/whisper.cpp), required for
  transcription
  - Pass `--whisper-binary-path` if not on PATH
  - Model file auto-downloads to `.cache/whispercpp/ggml-small.en.bin`
- **Silero VAD model** - auto-downloads to `.cache/silero-vad.onnx` on first use

## Installation

```bash
bun install
```

## Quick Start

```bash
bun src/process-course-video.ts "/path/to/input.mp4" "/path/to/output" \
  --enable-transcription \
  --keep-intermediates \
  --write-logs
```

## Web UI (experimental)

Start the Remix-powered UI shell (watch mode enabled):

```bash
bun run app:start
```

Then open `http://localhost:3000`. Use `-- --port` or `-- --host` to override
the defaults.

## CLI Options

| Option                   | Alias | Description                             | Default     |
| ------------------------ | ----- | --------------------------------------- | ----------- |
| `input`                  |       | Input video file (mp4/mkv)              | _required_  |
| `outputDir`              |       | Output directory                        | `output`    |
| `--min-chapter-seconds`  | `-m`  | Skip chapters shorter than this         | `15`        |
| `--dry-run`              | `-d`  | Don't write files or run ffmpeg         | `false`     |
| `--keep-intermediates`   | `-k`  | Keep `.tmp` files for debugging         | `false`     |
| `--write-logs`           | `-l`  | Write log files for skips/fallbacks     | `false`     |
| `--enable-transcription` |       | Run whisper.cpp for command detection   | `false`     |
| `--whisper-model-path`   |       | Path to whisper.cpp model file          | auto-cached |
| `--whisper-language`     |       | Language for whisper                    | `en`        |
| `--whisper-binary-path`  |       | Path to `whisper-cli` binary            | system PATH |
| `--chapter`              | `-c`  | Filter to specific chapters (see below) | all         |

## Chapter Selection

The `--chapter` flag supports flexible selection:

- Single: `--chapter 4`
- Range: `--chapter 4-6`
- Open range: `--chapter 4-*` (chapter 4 to end)
- Multiple: `--chapter 4,6,9-12`

Chapter numbers are 1-based by default.

## Output Structure

Final files are written to the output directory with names like:

```
chapter-01-intro.mp4
chapter-02-getting-started.mp4
chapter-03-custom-title.mp4
```

When `--keep-intermediates` is enabled, intermediate files go to `output/.tmp/`:

| File Pattern          | Description                                      |
| --------------------- | ------------------------------------------------ |
| `*-raw.mp4`           | Raw chapter clip with initial padding removed    |
| `*-normalized.mp4`    | Audio normalized (highpass + denoise + loudnorm) |
| `*-transcribe.wav`    | Audio extracted for whisper                      |
| `*-transcribe.json`   | Whisper JSON output                              |
| `*-transcribe.txt`    | Whisper text output                              |
| `*-splice-*.mp4`      | Segments before/after command windows            |
| `*-spliced.mp4`       | Concatenated output after command removal        |
| `*.log`               | Per-chapter skip/fallback logs                   |
| `process-summary.log` | Overall processing summary                       |

## Voice Commands

Commands are spoken in the format: `jarvis <command> ... thanks`

| Command                                 | Effect                  |
| --------------------------------------- | ----------------------- |
| `jarvis bad take thanks`                | Skip the entire chapter |
| `jarvis filename my-custom-name thanks` | Rename output file      |

The command window (from "jarvis" to "thanks") is removed from the final video.

## More Details

Implementation notes and pipeline details live in `docs/README.md`.

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
