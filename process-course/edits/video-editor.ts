import path from "node:path";
import os from "node:os";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { extractChapterSegmentAccurate, concatSegments } from "../ffmpeg";
import { buildKeepRanges, mergeTimeRanges } from "../utils/time-ranges";
import { EDIT_CONFIG } from "../config";
import { diffTranscripts, validateEditedTranscript } from "./transcript-diff";
import { refineAllRemovalRanges, wordsToTimeRanges } from "./timestamp-refinement";
import type { TimeRange } from "../types";
import type { TranscriptJson, TranscriptWordWithIndex } from "./types";

export interface EditVideoOptions {
  inputPath: string;
  transcriptJsonPath: string;
  editedTextPath: string;
  outputPath: string;
  paddingMs?: number;
}

export interface EditVideoResult {
  success: boolean;
  error?: string;
  outputPath?: string;
  removedWords: TranscriptWordWithIndex[];
  removedRanges: TimeRange[];
}

export function buildEditedOutputPath(inputPath: string): string {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.edited${parsed.ext}`);
}

export async function editVideo(options: EditVideoOptions): Promise<EditVideoResult> {
  try {
    const transcript = await readTranscriptJson(options.transcriptJsonPath);
    const editedText = await Bun.file(options.editedTextPath).text();
    const validation = validateEditedTranscript({
      originalWords: transcript.words,
      editedText,
    });
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        removedWords: [],
        removedRanges: [],
      };
    }
    const diffResult = diffTranscripts({
      originalWords: transcript.words,
      editedText,
    });
    if (!diffResult.success) {
      return {
        success: false,
        error: diffResult.error,
        removedWords: [],
        removedRanges: [],
      };
    }

    const removedWords = diffResult.removedWords;
    if (removedWords.length === 0) {
      await ensureOutputCopy(options.inputPath, options.outputPath);
      return {
        success: true,
        outputPath: options.outputPath,
        removedWords,
        removedRanges: [],
      };
    }

    const removalRanges = wordsToTimeRanges(removedWords);
    if (removalRanges.length === 0) {
      await ensureOutputCopy(options.inputPath, options.outputPath);
      return {
        success: true,
        outputPath: options.outputPath,
        removedWords,
        removedRanges: [],
      };
    }

    const refinedRanges = await refineAllRemovalRanges({
      inputPath: options.inputPath,
      duration: transcript.source_duration,
      ranges: removalRanges,
      paddingMs: options.paddingMs ?? EDIT_CONFIG.speechBoundaryPaddingMs,
    });
    const mergedRanges = mergeTimeRanges(
      refinedRanges.map((range) => range.refined),
    );
    const keepRanges = buildKeepRanges(
      0,
      transcript.source_duration,
      mergedRanges,
    );

    if (keepRanges.length === 0) {
      return {
        success: false,
        error: "Edits remove the entire video. Regenerate the transcript and retry.",
        removedWords,
        removedRanges: mergedRanges,
      };
    }

    await mkdir(path.dirname(options.outputPath), { recursive: true });

    const isFullRange =
      keepRanges.length === 1 &&
      keepRanges[0] &&
      keepRanges[0].start <= 0.001 &&
      keepRanges[0].end >= transcript.source_duration - 0.001;
    if (isFullRange) {
      await ensureOutputCopy(options.inputPath, options.outputPath);
      return {
        success: true,
        outputPath: options.outputPath,
        removedWords,
        removedRanges: mergedRanges,
      };
    }

    if (keepRanges.length === 1 && keepRanges[0]) {
      await extractChapterSegmentAccurate({
        inputPath: options.inputPath,
        outputPath: options.outputPath,
        start: keepRanges[0].start,
        end: keepRanges[0].end,
      });
      return {
        success: true,
        outputPath: options.outputPath,
        removedWords,
        removedRanges: mergedRanges,
      };
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "video-edit-"));
    try {
      const segmentPaths: string[] = [];
      for (const [index, range] of keepRanges.entries()) {
        const segmentPath = path.join(tempDir, `segment-${index + 1}.mp4`);
        await extractChapterSegmentAccurate({
          inputPath: options.inputPath,
          outputPath: segmentPath,
          start: range.start,
          end: range.end,
        });
        segmentPaths.push(segmentPath);
      }
      if (segmentPaths.length === 1) {
        await ensureOutputCopy(segmentPaths[0], options.outputPath);
      } else {
        await concatSegments({
          segmentPaths,
          outputPath: options.outputPath,
        });
      }
      return {
        success: true,
        outputPath: options.outputPath,
        removedWords,
        removedRanges: mergedRanges,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      removedWords: [],
      removedRanges: [],
    };
  }
}

async function ensureOutputCopy(inputPath: string, outputPath: string) {
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedInput === resolvedOutput) {
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await copyFile(inputPath, outputPath);
}

async function readTranscriptJson(transcriptJsonPath: string): Promise<TranscriptJson> {
  const raw = await Bun.file(transcriptJsonPath).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Transcript JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Transcript JSON is not an object.");
  }
  const payload = parsed as TranscriptJson;
  if (payload.version !== 1) {
    throw new Error("Unsupported transcript JSON version.");
  }
  if (!payload.source_video || typeof payload.source_video !== "string") {
    throw new Error("Transcript JSON missing source_video.");
  }
  if (
    typeof payload.source_duration !== "number" ||
    !Number.isFinite(payload.source_duration) ||
    payload.source_duration <= 0
  ) {
    throw new Error("Transcript JSON has invalid source_duration.");
  }
  if (!Array.isArray(payload.words)) {
    throw new Error("Transcript JSON missing words array.");
  }
  const words: TranscriptWordWithIndex[] = payload.words.map((word, index) => {
    if (!word || typeof word !== "object") {
      throw new Error(`Transcript JSON word ${index} is invalid.`);
    }
    const entry = word as TranscriptWordWithIndex;
    if (typeof entry.word !== "string") {
      throw new Error(`Transcript JSON word ${index} missing word.`);
    }
    if (typeof entry.start !== "number" || typeof entry.end !== "number") {
      throw new Error(`Transcript JSON word ${index} missing timing.`);
    }
    if (typeof entry.index !== "number") {
      throw new Error(`Transcript JSON word ${index} missing index.`);
    }
    return entry;
  });
  return {
    version: 1,
    source_video: payload.source_video,
    source_duration: payload.source_duration,
    words,
  };
}
