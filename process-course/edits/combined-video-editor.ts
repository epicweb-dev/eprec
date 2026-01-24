import path from "node:path";
import os from "node:os";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { detectSpeechBounds, checkSegmentHasSpeech } from "../../speech-detection";
import { findSilenceBoundary } from "../jarvis-commands/windows";
import { extractChapterSegmentAccurate, concatSegments, readAudioSamples } from "../ffmpeg";
import { clamp, runCommand } from "../../utils";
import { CONFIG, EDIT_CONFIG } from "../config";
import { editVideo } from "./video-editor";
import { findSpeechEndWithRms, findSpeechStartWithRms } from "../utils/audio-analysis";

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

    const video1TrimEnd = await findVideo1TrimEnd({
      inputPath: video1Path,
      duration: video1Duration,
      paddingSeconds,
    });
    const { trimStart: video2TrimStart, trimEnd: video2TrimEnd } =
      await findVideo2Trim({
        inputPath: video2Path,
        duration: video2Duration,
        paddingSeconds,
      });

    const segment1Path = path.join(tempDir, "segment-1.mp4");
    const segment2Path = path.join(tempDir, "segment-2.mp4");
    await extractChapterSegmentAccurate({
      inputPath: video1Path,
      outputPath: segment1Path,
      start: 0,
      end: video1TrimEnd,
    });
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

async function findVideo1TrimEnd(options: {
  inputPath: string;
  duration: number;
  paddingSeconds: number;
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
  const silenceBoundary = await findSilenceBoundary({
    inputPath: options.inputPath,
    duration: options.duration,
    targetTime: effectiveSpeechEnd,
    direction: "before",
    maxSearchSeconds: EDIT_CONFIG.speechSearchWindowSeconds,
  });
  const rawEnd = silenceBoundary ?? effectiveSpeechEnd;
  const safeEnd = Math.max(rawEnd, effectiveSpeechEnd);
  return clamp(safeEnd + options.paddingSeconds, 0, options.duration);
}

async function findVideo2Trim(options: {
  inputPath: string;
  duration: number;
  paddingSeconds: number;
}): Promise<{ trimStart: number; trimEnd: number }> {
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
  const speechEnd = speechBounds.end;
  const silenceBoundary = await findSilenceBoundary({
    inputPath: options.inputPath,
    duration: options.duration,
    targetTime: speechStart,
    direction: "after",
    maxSearchSeconds: EDIT_CONFIG.speechSearchWindowSeconds,
  });
  const rawStart = silenceBoundary ?? speechStart;
  const safeStart = Math.min(rawStart, speechStart);
  return {
    trimStart: clamp(safeStart - options.paddingSeconds, 0, options.duration),
    trimEnd: clamp(speechEnd + options.paddingSeconds, 0, options.duration),
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

async function findSpeechEndWithRmsFallback(options: {
  inputPath: string;
  start: number;
  duration: number;
}): Promise<number | null> {
  if (options.duration <= 0.05) {
    return null;
  }
  const samples = await readAudioSamples({
    inputPath: options.inputPath,
    start: options.start,
    duration: options.duration,
    sampleRate: CONFIG.vadSampleRate,
  });
  if (samples.length === 0) {
    return null;
  }
  return findSpeechEndWithRms({
    samples,
    sampleRate: CONFIG.vadSampleRate,
    rmsWindowMs: CONFIG.commandSilenceRmsWindowMs,
    rmsThreshold: CONFIG.commandSilenceRmsThreshold,
  });
}

async function findSpeechStartWithRmsFallback(options: {
  inputPath: string;
  start: number;
  duration: number;
}): Promise<number | null> {
  if (options.duration <= 0.05) {
    return null;
  }
  const samples = await readAudioSamples({
    inputPath: options.inputPath,
    start: options.start,
    duration: options.duration,
    sampleRate: CONFIG.vadSampleRate,
  });
  if (samples.length === 0) {
    return null;
  }
  return findSpeechStartWithRms({
    samples,
    sampleRate: CONFIG.vadSampleRate,
    rmsWindowMs: CONFIG.commandSilenceRmsWindowMs,
    rmsThreshold: CONFIG.commandSilenceRmsThreshold,
  });
}
