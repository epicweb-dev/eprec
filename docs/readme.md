# epic-recording docs

## Overview
This repo is a Bun-based CLI that processes a recorded course video by splitting
chapter markers into separate files, trimming silence at the start/end, and
optionally removing spoken "Jarvis" command windows via transcript timestamps
refined with audio-based silence detection.

The main entry point is `process-course-video.ts`. The default `index.ts` is a
placeholder.

## Requirements
- Bun (runtime + package manager).
- ffmpeg + ffprobe available on PATH.
- If using transcription:
  - `whisper-cli` from whisper.cpp on PATH (or pass `--whisper-binary-path`).
  - Model file (auto-downloaded to `.cache/whispercpp/ggml-tiny.en.bin`).
- VAD uses `onnxruntime-node` and downloads a Silero VAD model on first use.

## Quick start
```bash
bun install
bun process-course-video.ts "/path/to/input.mp4" "/path/to/output" \
  --min-chapter-seconds 2 \
  --enable-transcription \
  --keep-intermediates \
  --write-logs
```

## CLI usage
The CLI accepts:
- `input` (required): input video file (mp4/mkv).
- `outputDir` (optional): default `output`.
- `--min-chapter-seconds` / `-m`: skip very short chapters.
- `--dry-run` / `-d`: don't write files or run ffmpeg.
- `--keep-intermediates` / `-k`: keep `.tmp` files for debugging.
- `--write-logs` / `-l`: write log files for skips/fallbacks.
- `--enable-transcription`: run whisper.cpp command detection.
- `--whisper-model-path`: model file (defaults to cached tiny model).
- `--whisper-language`: language passed to whisper.
- `--whisper-binary-path`: path to `whisper-cli`.
- `--whisper-skip-phrase`: repeatable skip phrases.
- `--chapter` / `-c`: filter to specific chapter numbers/ranges.

See `process-course-video.ts` for the authoritative parser.

## Output structure
Output is written to the output directory. When `--keep-intermediates` is
enabled, intermediate files land in `output/.tmp/`:
- `*-raw.mp4`: raw chapter clip with initial padding removed.
- `*-normalized.mp4`: normalized audio (highpass + denoise + loudnorm).
- `*-transcribe.wav` / `*.json` / `*.txt`: whisper inputs/outputs.
- `*-splice-*.mp4`: pre/post command-window segments.
- `*-spliced.mp4`: concatenated output after command removal.
- `process-summary.log`: summary if `--write-logs` is enabled.

Final files follow chapter titles (or rename via filename command), e.g.
`chapter-03-test-in-the-middle.mp4`.

## Key processing stages
1. **Chapter discovery** via ffprobe `-show_chapters`.
2. **Initial trim**: removes `rawTrimPaddingSeconds` from both ends.
3. **Speech bounds**: VAD detects first/last speech in the chapter.
4. **Padding**: adds `preSpeechPaddingSeconds`/`postSpeechPaddingSeconds`.
5. **Normalization**: highpass + afftdn + loudnorm.
6. **Transcription (optional)**:
   - Whisper.cpp transcript is parsed to find commands.
   - "bad take" skips the chapter.
   - "filename" command renames output.
7. **Command window removal**:
   - Transcript timestamps are padded and refined to silence.
   - Windows are merged and removed via segment splicing/concat.
8. **Post-splice trim**:
   - Speech bounds re-detected and trimmed on spliced output.
9. **Final extract** to output file.

## Transcription + command handling
Commands are extracted from whisper tokens/segments:
- Wake word: `jarvis`.
- Close word: `thanks`.
- Commands include `bad-take` and `filename <value>`.

Command windows are refined using:
- Silero VAD (speech segments) to find nearby silence gaps.
- RMS fallback when VAD is unavailable.
- A backward-trim cap to avoid removing too much pre-wake speech.

## Speech detection (VAD)
The VAD pipeline:
- Audio is read as mono float samples.
- Silero VAD runs via ONNX, producing speech probabilities.
- Probabilities are converted into speech segments.
- If VAD fails, the full clip is used as a fallback.

## Logging + debugging
When `--write-logs` is enabled, skip and fallback details are written to
`output/.tmp/*.log` and a summary log is generated.

## Caches
- VAD model: `.cache/silero-vad.onnx` (downloaded on first use).
- Whisper model: `.cache/whispercpp/ggml-tiny.en.bin`.
