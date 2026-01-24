# eprec implementation details

This document covers processing internals and operational notes. For primary
usage and CLI options, see the root `README.md`.

## Processing Pipeline

1. **Chapter discovery** - Extract chapters via `ffprobe -show_chapters`
2. **Initial trim** - Remove 0.1s padding from both ends
3. **Raw extraction** - Extract chapter segment from source video
4. **Audio normalization** - Apply highpass filter, noise reduction (`afftdn`),
   and EBU R128 loudness normalization
5. **Transcription** _(optional)_ - Run whisper.cpp on normalized audio
6. **Command parsing** - Extract Jarvis commands from transcript
7. **Skip check** - Skip chapter if "bad take" command detected or transcript
   has ≤10 words
8. **Command window removal** - Splice out command windows (or trim if command
   is at end)
9. **Speech bounds detection** - VAD detects first/last speech in final content
10. **Padded trim** - Add padding around speech bounds (0.25s before, 0.35s
    after)
11. **Final extraction** - Write final chapter file

## Command Window Refinement

Command timestamps are refined to silence boundaries using:

1. **Direct check** - Keep timestamp if already at silence
2. **VAD gaps** - Find nearest silence gap via Silero VAD
3. **RMS fallback** - Detect low-RMS windows when VAD unavailable
4. **Backward cap** - Limit backward expansion to 0.2s max to avoid cutting
   speech

## Speech Detection (VAD)

The VAD pipeline uses Silero VAD via ONNX:

1. Audio read as mono 16kHz float samples
2. Silero model produces per-window speech probabilities
3. Probabilities converted to speech segments with hysteresis
4. First/last speech timestamps used for trimming
5. Falls back to full clip if VAD fails

## Logging and Debugging

When `--write-logs` is enabled:

- Per-chapter logs written to `output/.tmp/*.log` for skips and fallbacks
- Summary log written to `output/.tmp/process-summary.log`

## Caches

Models are automatically downloaded and cached:

| File                                  | Source                     |
| ------------------------------------- | -------------------------- |
| `.cache/silero-vad.onnx`              | Hugging Face (Silero VAD)  |
| `.cache/whispercpp/ggml-small.en.bin` | Hugging Face (whisper.cpp) |

## Whisper.cpp Transcription Notes

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

## Source Files

| File                        | Description                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| `process-course-video.ts`   | Main CLI entry point                                              |
| `process-course/config.ts`  | Shared constants and tuning parameters                            |
| `process-course/logging.ts` | CLI logging helpers                                               |
| `process-course/paths.ts`   | Output/intermediate path helpers                                  |
| `process-course/types.ts`   | Shared types used by the CLI                                      |
| `process-course/utils.ts`   | Transcript parsing, time range, audio analysis, and CLI utilities |
| `speech-detection.ts`       | Silero VAD integration                                            |
| `whispercpp-transcribe.ts`  | Whisper.cpp integration                                           |
| `utils.ts`                  | Shared utilities                                                  |

# eprec

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

## Quick Start

```bash
bun install
bun process-course-video.ts "/path/to/input.mp4" "/path/to/output" \
  --enable-transcription \
  --keep-intermediates \
  --write-logs
```

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

### Chapter Selection

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

## Processing Pipeline

1. **Chapter discovery** - Extract chapters via `ffprobe -show_chapters`
2. **Initial trim** - Remove 0.1s padding from both ends
3. **Raw extraction** - Extract chapter segment from source video
4. **Audio normalization** - Apply highpass filter, noise reduction (`afftdn`),
   and EBU R128 loudness normalization
5. **Transcription** _(optional)_ - Run whisper.cpp on normalized audio
6. **Command parsing** - Extract Jarvis commands from transcript
7. **Skip check** - Skip chapter if "bad take" command detected or transcript
   has ≤10 words
8. **Command window removal** - Splice out command windows (or trim if command
   is at end)
9. **Speech bounds detection** - VAD detects first/last speech in final content
10. **Padded trim** - Add padding around speech bounds (0.25s before, 0.35s
    after)
11. **Final extraction** - Write final chapter file

## Voice Commands

Commands are spoken in the format: `jarvis <command> ... thanks`

| Command                                 | Effect                  |
| --------------------------------------- | ----------------------- |
| `jarvis bad take thanks`                | Skip the entire chapter |
| `jarvis filename my-custom-name thanks` | Rename output file      |

The command window (from "jarvis" to "thanks") is removed from the final video.

### Command Window Refinement

Command timestamps are refined to silence boundaries using:

1. **Direct check** - Keep timestamp if already at silence
2. **VAD gaps** - Find nearest silence gap via Silero VAD
3. **RMS fallback** - Detect low-RMS windows when VAD unavailable
4. **Backward cap** - Limit backward expansion to 0.2s max to avoid cutting
   speech

## Speech Detection (VAD)

The VAD pipeline uses Silero VAD via ONNX:

1. Audio read as mono 16kHz float samples
2. Silero model produces per-window speech probabilities
3. Probabilities converted to speech segments with hysteresis
4. First/last speech timestamps used for trimming
5. Falls back to full clip if VAD fails

## Logging and Debugging

When `--write-logs` is enabled:

- Per-chapter logs written to `output/.tmp/*.log` for skips and fallbacks
- Summary log written to `output/.tmp/process-summary.log`

## Caches

Models are automatically downloaded and cached:

| File                                  | Source                     |
| ------------------------------------- | -------------------------- |
| `.cache/silero-vad.onnx`              | Hugging Face (Silero VAD)  |
| `.cache/whispercpp/ggml-small.en.bin` | Hugging Face (whisper.cpp) |

## Source Files

| File                        | Description                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| `process-course-video.ts`   | Main CLI entry point                                              |
| `process-course/config.ts`  | Shared constants and tuning parameters                            |
| `process-course/logging.ts` | CLI logging helpers                                               |
| `process-course/paths.ts`   | Output/intermediate path helpers                                  |
| `process-course/types.ts`   | Shared types used by the CLI                                      |
| `process-course/utils.ts`   | Transcript parsing, time range, audio analysis, and CLI utilities |
| `speech-detection.ts`       | Silero VAD integration                                            |
| `whispercpp-transcribe.ts`  | Whisper.cpp integration                                           |
| `utils.ts`                  | Shared utilities                                                  |
