# Processing pipeline details

## High-level flow

The pipeline operates on a single input video and writes one output file per
chapter. Each chapter is processed independently.

```
input video
  -> ffprobe chapters
  -> raw chapter clip
  -> exit early if shorter than threshold
  -> normalized audio
  -> whisper transcript
  -> exit early if 10 words or less
  -> check for commands
  -> spliced output (if command mid-video; if at end, just trim)
  -> VAD speech bounds
  -> padded trim window
  -> final chapter output
```

## Chapter selection

The `--chapter` flag supports:

- single numbers: `4`
- ranges: `4-6`
- open ranges: `4-*`
- comma-separated lists: `4,6,9-12`

If omitted, all chapters are processed.

## Normalization

Audio normalization is applied to the raw chapter clip:

- Highpass filter + noise reduction (`afftdn`).
- EBU R128 loudness normalization (`loudnorm`) with configurable target.

The normalized file is the basis for transcription and splicing.

## Speech bounds trimming

Speech detection runs after all content manipulation (splicing) is complete:

- `readAudioSamples` uses ffmpeg to read mono float samples.
- `detectSpeechSegmentsWithVad` returns speech ranges.
- Bounds are padded by `preSpeechPaddingSeconds` and `postSpeechPaddingSeconds`.

If VAD fails, the whole chapter is used and a fallback note is logged.

## Transcription + command parsing

Whisper output is parsed from JSON:

- Tokens are preferred when available.
- Segments are used otherwise.

Commands are extracted from the token timeline:

- `jarvis <command> ... thanks`
- `jarvis bad take`
- `jarvis filename <value>`

The command window is built from the token start/end times and padded.

## Command window refinement

Each command window is refined to silence using:

1. **Check at timestamp**: if RMS at the boundary is already silent, keep it.
2. **VAD silence gap search**: use nearest gap before/after.
3. **RMS fallback**: detect a run of low-RMS windows.
4. **Backward cap**: if the refined start is too far back, clamp to original
   timestamp to avoid over-trimming pre-command speech.

Windows are merged and spliced out with ffmpeg.

## Splicing

Commands detected mid-video are spliced out:

- Keep ranges are extracted as accurate segments (re-encoded).
- Segments are concatenated into a single spliced output.

If a command is at the end of the video, it is simply trimmed off without
requiring a full splice operation.

After splicing (or if no splicing was needed), VAD runs on the final content to
detect speech bounds, which are then padded for the final output.
