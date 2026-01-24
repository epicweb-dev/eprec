#!/usr/bin/env bun
import path from "node:path";
import os from "node:os";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { extractTranscriptionAudio } from "../ffmpeg";
import { transcribeAudio } from "../../whispercpp-transcribe";
import { scaleTranscriptSegments } from "../jarvis-commands/parser";
import { EDIT_CONFIG } from "../config";
import {
  buildTranscriptWordsWithIndices,
  generateTranscriptJson,
  generateTranscriptText,
} from "./transcript-output";
import { runCommand } from "../../utils";

async function main() {
  const argv = yargs(hideBin(process.argv))
    .scriptName("regenerate-transcript")
    .option("dir", {
      type: "string",
      demandOption: true,
      describe: "Edits directory containing transcript files",
    })
    .help()
    .parseSync();

  const editsDir = path.resolve(String(argv.dir));
  const originalPath = await findOriginalVideo(editsDir);
  const duration = await getMediaDurationSeconds(originalPath);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "edit-transcript-"));
  const audioPath = path.join(tempDir, "transcribe.wav");
  const outputBasePath = path.join(tempDir, "transcript");

  try {
    await extractTranscriptionAudio({
      inputPath: originalPath,
      outputPath: audioPath,
      start: 0,
      end: duration,
    });

    const transcription = await transcribeAudio(audioPath, {
      outputBasePath,
    });
    const segments =
      transcription.segmentsSource === "tokens"
        ? transcription.segments
        : scaleTranscriptSegments(transcription.segments, duration);
    const words = buildTranscriptWordsWithIndices(segments);

    const transcriptText = generateTranscriptText(words);
    const transcriptJson = generateTranscriptJson({
      sourceVideo: path.basename(originalPath),
      sourceDuration: duration,
      words,
    });

    await Bun.write(path.join(editsDir, "transcript.txt"), transcriptText);
    await Bun.write(path.join(editsDir, "transcript.json"), transcriptJson);
  } finally {
    if (!EDIT_CONFIG.keepEditIntermediates) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function findOriginalVideo(editsDir: string): Promise<string> {
  const entries = await readdir(editsDir);
  const originalFile = entries.find((entry) => entry.startsWith("original."));
  if (!originalFile) {
    throw new Error(`No original video found in ${editsDir}.`);
  }
  return path.join(editsDir, originalFile);
}

async function getMediaDurationSeconds(filePath: string): Promise<number> {
  const result = await runCommand([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid duration for ${filePath}: ${result.stdout}`);
  }
  return duration;
}

main().catch((error) => {
  console.error(
    `[error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
