# Cloud Agent Instructions

## Project Overview

**epic-recording** is a Bun-based CLI tool for processing recorded course videos. It splits videos by chapters, trims silence, normalizes audio, and removes "Jarvis" voice commands.

## Commands

| Action | Command |
|--------|---------|
| Run unit tests | `bun run test` |
| Run E2E tests | `bun run test:e2e` |
| Run all tests | `bun run test:all` |
| Run CLI | `bun process-course-video.ts <input> <output> [options]` |
| CLI help | `bun process-course-video.ts --help` |

## System Requirements

- **ffmpeg/ffprobe**: Required for video processing (must be on PATH)
- **whisper-cli**: Required for transcription (whisper.cpp CLI, must be on PATH)

## AI Models

Models auto-download to `.cache/` on first use:
- `silero-vad.onnx` - Voice Activity Detection
- `whispercpp/ggml-small.en.bin` - Whisper speech-to-text model (~465MB)

## Testing Notes

- E2E tests have 5 minute timeout due to video processing
- Tests use fixture video at `fixtures/e2e-test.mp4`
- Use `--dry-run` flag to test CLI without writing files

## CLI Options

Key options:
- `--dry-run` / `-d`: Skip writing output files
- `--keep-intermediates` / `-k`: Keep intermediate files for debugging
- `--min-chapter-seconds N` / `-m N`: Skip chapters shorter than N seconds
- `--enable-transcription`: Enable whisper transcription (default: true)
- `--chapter N` / `-c N`: Only process specific chapters (e.g., `4`, `4-6`, `4,6,9-12`)
