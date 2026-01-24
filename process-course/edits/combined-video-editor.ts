import path from "node:path";
import os from "node:os";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { detectSpeechBounds, checkSegmentHasSpeech } from "../../speech-detection";
import { extractChapterSegmentAccurate, concatSegments } from "../ffmpeg";
import { clamp, getMediaDurationSeconds } from "../../utils";
import { EDIT_CONFIG } from "../config";
import { editVideo } from "./video-editor";
import { findSpeechEndWithRmsFallback, findSpeechStartWithRmsFallback } from "../utils/audio-analysis";
import { allocateJoinPadding } from "../utils/video-editing";

export interface CombineVideosOptions {
  video1Path: string;
  video1TranscriptJsonPath?: string;
  video1EditedTextPath?: string;
  video1Duration?: number;
  video2Path: string;
  video2TranscriptJsonPath?: string;
  video2EditedTextPath?: string;
  video2Duration?: number;
  outputPath: string;
  overlapPaddingMs?: number;
}

export interface CombineVideosResult {
  success: boolean;
  error?: string;
  outputPath?: string;
  video1TrimEnd: number;
  video2TrimStart: number;
}

export async function combineVideos(
  options: CombineVideosOptions,
): Promise<CombineVideosResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "video-combine-"));
  try {
    const { video1Path, video2Path } = await applyOptionalEdits(options, tempDir);
    const video1Duration =
      options.video1Duration ?? (await getMediaDurationSeconds(video1Path));
    const video2Duration =
      options.video2Duration ?? (await getMediaDurationSeconds(video2Path));

    const video1HasSpeech = await checkSegmentHasSpeech(
      video1Path,
      video1Duration,
    );
    if (!video1HasSpeech) {
      return {
        success: false,
        error: "First video has no speech; cannot combine.",
        video1TrimEnd: 0,
        video2TrimStart: 0,
      };
    }

    const paddingSeconds =
      (options.overlapPaddingMs ?? EDIT_CONFIG.speechBoundaryPaddingMs) / 1000;

    const video1SpeechEnd = await findVideo1SpeechEnd({
      inputPath: video1Path,
      duration: video1Duration,
    });
    const { speechStart: video2SpeechStart, speechEnd: video2SpeechEnd } =
      await findVideo2SpeechBounds({
        inputPath: video2Path,
        duration: video2Duration,
      });
    const video1AvailableSilence = Math.max(0, video1Duration - video1SpeechEnd);
    const video2AvailableSilence = Math.max(0, video2SpeechStart);
    const { previousPaddingSeconds, currentPaddingSeconds } = allocateJoinPadding({
      paddingSeconds,
      previousAvailableSeconds: video1AvailableSilence,
      currentAvailableSeconds: video2AvailableSilence,
    });
    const video1TrimEnd = clamp(
      video1SpeechEnd + previousPaddingSeconds,
      0,
      video1Duration,
    );
    const video2TrimStart = clamp(
      video2SpeechStart - currentPaddingSeconds,
      0,
      video2Duration,
    );
    const video2TrimEnd = clamp(
      video2SpeechEnd + paddingSeconds,
      0,
      video2Duration,
    );

    const segment1Path = path.join(tempDir, "segment-1.mp4");
    const segment2Path = path.join(tempDir, "segment-2.mp4");
    await extractChapterSegmentAccurate({
      inputPath: video1Path,
      outputPath: segment1Path,
      start: 0,
      end: video1TrimEnd,
    });
    if (video2TrimEnd <= video2TrimStart + 0.005) {
      return {
        success: false,
        error: `Invalid trim bounds for second video: start (${video2TrimStart.toFixed(3)}s) >= end (${video2TrimEnd.toFixed(3)}s)`,
        video1TrimEnd,
        video2TrimStart,
      };
    }
    await extractChapterSegmentAccurate({
      inputPath: video2Path,
      outputPath: segment2Path,
      start: video2TrimStart,
      end: video2TrimEnd,
    });

    const segment2HasSpeech = await checkSegmentHasSpeech(
      segment2Path,
      video2TrimEnd - video2TrimStart,
    );
    if (!segment2HasSpeech) {
      return {
        success: false,
        error: "Second video has no speech after trimming.",
        video1TrimEnd,
        video2TrimStart,
      };
    }

    const resolvedOutputPath = await resolveOutputPath(
      options.outputPath,
      video1Path,
      video2Path,
      tempDir,
    );
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await concatSegments({
      segmentPaths: [segment1Path, segment2Path],
      outputPath: resolvedOutputPath,
    });
    await finalizeOutput(resolvedOutputPath, options.outputPath);

    return {
      success: true,
      outputPath: options.outputPath,
      video1TrimEnd,
      video2TrimStart,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      video1TrimEnd: 0,
      video2TrimStart: 0,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function applyOptionalEdits(
  options: CombineVideosOptions,
  tempDir: string,
): Promise<{ video1Path: string; video2Path: string }> {
  let video1Path = options.video1Path;
  let video2Path = options.video2Path;

  if (options.video1EditedTextPath) {
    if (!options.video1TranscriptJsonPath) {
      throw new Error("Missing transcript JSON for first video edits.");
    }
    const editedPath = path.join(tempDir, "video1-edited.mp4");
    const result = await editVideo({
      inputPath: options.video1Path,
      transcriptJsonPath: options.video1TranscriptJsonPath,
      editedTextPath: options.video1EditedTextPath,
      outputPath: editedPath,
      paddingMs: options.overlapPaddingMs,
    });
    if (!result.success) {
      throw new Error(result.error ?? "Failed to edit first video.");
    }
    video1Path = editedPath;
  }

  if (options.video2EditedTextPath) {
    if (!options.video2TranscriptJsonPath) {
      throw new Error("Missing transcript JSON for second video edits.");
    }
    const editedPath = path.join(tempDir, "video2-edited.mp4");
    const result = await editVideo({
      inputPath: options.video2Path,
      transcriptJsonPath: options.video2TranscriptJsonPath,
      editedTextPath: options.video2EditedTextPath,
      outputPath: editedPath,
      paddingMs: options.overlapPaddingMs,
    });
    if (!result.success) {
      throw new Error(result.error ?? "Failed to edit second video.");
    }
    video2Path = editedPath;
  }

  return { video1Path, video2Path };
}

async function findVideo1SpeechEnd(options: {
  inputPath: string;
  duration: number;
}): Promise<number> {
  const endSearchWindow = Math.min(
    options.duration * 0.3,
    EDIT_CONFIG.speechSearchWindowSeconds * 2,
  );
  const endSearchStart = Math.max(0, options.duration - endSearchWindow);
  const speechBounds = await detectSpeechBounds(
    options.inputPath,
    endSearchStart,
    options.duration,
    options.duration,
  );
  const speechEnd = speechBounds.note
    ? speechBounds.end
    : endSearchStart + speechBounds.end;
  let effectiveSpeechEnd = speechEnd;
  if (speechBounds.note || options.duration - speechEnd < 0.05) {
    const rmsSpeechEnd = await findSpeechEndWithRmsFallback({
      inputPath: options.inputPath,
      start: endSearchStart,
      duration: options.duration - endSearchStart,
    });
    if (rmsSpeechEnd !== null) {
      effectiveSpeechEnd = endSearchStart + rmsSpeechEnd;
    }
  }
  return effectiveSpeechEnd;
}

async function findVideo2SpeechBounds(options: {
  inputPath: string;
  duration: number;
}): Promise<{ speechStart: number; speechEnd: number }> {
  const speechBounds = await detectSpeechBounds(
    options.inputPath,
    0,
    options.duration,
    options.duration,
  );
  let speechStart = speechBounds.start;
  if (speechBounds.note || speechBounds.start <= 0.05) {
    const rmsSpeechStart = await findSpeechStartWithRmsFallback({
      inputPath: options.inputPath,
      start: 0,
      duration: options.duration,
    });
    if (rmsSpeechStart !== null) {
      speechStart = rmsSpeechStart;
    }
  }
  let speechEnd = speechBounds.end;
  if (speechBounds.note || options.duration - speechBounds.end < 0.05) {
    const rmsSpeechEnd = await findSpeechEndWithRmsFallback({
      inputPath: options.inputPath,
      start: 0,
      duration: options.duration,
    });
    if (rmsSpeechEnd !== null) {
      speechEnd = rmsSpeechEnd;
    }
  }
  return {
    speechStart,
    speechEnd,
  };
}

async function resolveOutputPath(
  outputPath: string,
  video1Path: string,
  video2Path: string,
  tempDir: string,
): Promise<string> {
  const resolvedOutput = path.resolve(outputPath);
  const resolvedVideo1 = path.resolve(video1Path);
  const resolvedVideo2 = path.resolve(video2Path);
  if (resolvedOutput === resolvedVideo1 || resolvedOutput === resolvedVideo2) {
    return path.join(tempDir, `combined-output${path.extname(outputPath)}`);
  }
  return outputPath;
}

async function finalizeOutput(tempOutputPath: string, outputPath: string) {
  const resolvedTemp = path.resolve(tempOutputPath);
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedTemp === resolvedOutput) {
    return;
  }
  await rm(outputPath, { force: true });
  try {
    await rename(tempOutputPath, outputPath);
  } catch {
    await copyFile(tempOutputPath, outputPath);
  }
}
