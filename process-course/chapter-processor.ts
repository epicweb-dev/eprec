import path from "node:path";
import { detectSpeechBounds, checkSegmentHasSpeech } from "../speech-detection";
import { transcribeAudio } from "../whispercpp-transcribe";
import { clamp, formatSeconds } from "../utils";
import { COMMAND_CLOSE_WORD, COMMAND_WAKE_WORD, CONFIG } from "./config";
import {
  analyzeLoudness,
  concatSegments,
  extractChapterSegment,
  extractChapterSegmentAccurate,
  extractTranscriptionAudio,
  renderChapter,
} from "./ffmpeg";
import {
  buildIntermediateAudioPath,
  buildIntermediatePath,
  buildJarvisOutputBase,
  buildTranscriptionOutputBase,
} from "./paths";
import { logInfo, logWarn, writeChapterLog } from "./logging";
import { mergeTimeRanges, buildKeepRanges } from "./utils/time-ranges";
import { safeUnlink } from "./utils/file-utils";
import { formatChapterFilename } from "./utils/filename";
import { transcriptIncludesWord } from "./utils/transcript";
import {
  extractTranscriptCommands,
  scaleTranscriptSegments,
  buildCommandWindows,
  refineCommandWindows,
  analyzeCommands,
  formatCommandTypes,
} from "./jarvis-commands";
import type { Chapter, TimeRange, JarvisWarning, JarvisEdit } from "./types";

export interface ChapterProcessingOptions {
  inputPath: string;
  outputDir: string;
  tmpDir: string;
  minChapterDurationSeconds: number;
  enableTranscription: boolean;
  whisperModelPath: string;
  whisperLanguage: string;
  whisperBinaryPath: string | undefined;
  keepIntermediates: boolean;
  writeLogs: boolean;
  dryRun: boolean;
}

export interface ChapterProcessingResult {
  status: "processed" | "skipped";
  skipReason?:
    | "short-initial"
    | "short-trimmed"
    | "transcript"
    | "bad-take"
    | "dry-run";
  jarvisWarning?: JarvisWarning;
  jarvisEdit?: JarvisEdit;
  fallbackNote?: string;
  logWritten: boolean;
}

/**
 * Process a single chapter: extract, normalize, detect commands, splice, trim, and output.
 */
export async function processChapter(
  chapter: Chapter,
  options: ChapterProcessingOptions,
): Promise<ChapterProcessingResult> {
  const duration = chapter.end - chapter.start;
  if (duration <= 0) {
    throw new Error(
      `Invalid chapter duration for "${chapter.title}" (${duration}s)`,
    );
  }

  const outputBasePath = path.join(
    options.outputDir,
    `${formatChapterFilename(chapter)}${path.extname(options.inputPath)}`,
  );

  // Check minimum duration before processing
  if (duration < options.minChapterDurationSeconds) {
    logInfo(
      `Skipping chapter ${chapter.index + 1}: ${chapter.title} (${formatSeconds(duration)})`,
    );
    let logWritten = false;
    if (options.writeLogs && !options.dryRun) {
      await writeChapterLog(options.tmpDir, outputBasePath, [
        `Chapter: ${chapter.index + 1} - ${chapter.title}`,
        `Input: ${options.inputPath}`,
        `Duration: ${formatSeconds(duration)}`,
        `Skip threshold: ${formatSeconds(options.minChapterDurationSeconds)}`,
        "Reason: Chapter shorter than minimum duration threshold.",
      ]);
      logWritten = true;
    }
    return { status: "skipped", skipReason: "short-initial", logWritten };
  }

  // Dry run - don't actually process
  if (options.dryRun) {
    logInfo(
      `[dry-run] Would process chapter ${chapter.index + 1}: ${chapter.title}`,
    );
    return { status: "processed", skipReason: "dry-run", logWritten: false };
  }

  logInfo(`Processing chapter ${chapter.index + 1}: ${chapter.title}`);

  // Build all intermediate paths
  const paths = buildIntermediatePaths(options.tmpDir, outputBasePath);

  try {
    // Step 1: Extract raw segment with padding trimmed
    const rawTrimStart = chapter.start + CONFIG.rawTrimPaddingSeconds;
    const rawTrimEnd = chapter.end - CONFIG.rawTrimPaddingSeconds;
    const rawDuration = rawTrimEnd - rawTrimStart;
    if (rawDuration <= 0) {
      throw new Error(
        `Chapter too short to trim ${CONFIG.rawTrimPaddingSeconds}s from both ends (${formatSeconds(duration)}).`,
      );
    }

    await extractChapterSegment({
      inputPath: options.inputPath,
      outputPath: paths.rawPath,
      start: rawTrimStart,
      end: rawTrimEnd,
    });

    // Step 2: Normalize audio
    const analysis = await analyzeLoudness(paths.rawPath, 0, rawDuration);
    await renderChapter({
      inputPath: paths.rawPath,
      outputPath: paths.normalizedPath,
      absoluteStart: 0,
      absoluteEnd: rawDuration,
      analysis,
    });

    // Step 3: Transcribe and analyze commands
    let commandWindows: TimeRange[] = [];
    let commandFilenameOverride: string | null = null;
    let hasEditCommand = false;

    if (options.enableTranscription) {
      const transcriptionResult = await transcribeAndAnalyze({
        normalizedPath: paths.normalizedPath,
        transcriptionAudioPath: paths.transcriptionAudioPath,
        transcriptionOutputBase: paths.transcriptionOutputBase,
        rawDuration,
        options,
      });

      if (transcriptionResult.shouldSkip) {
        let logWritten = false;
        if (options.writeLogs) {
          await writeChapterLog(options.tmpDir, outputBasePath, [
            `Chapter: ${chapter.index + 1} - ${chapter.title}`,
            `Input: ${options.inputPath}`,
            `Duration: ${formatSeconds(duration)}`,
            `Reason: ${transcriptionResult.skipReason}`,
          ]);
          logWritten = true;
        }
        await safeUnlink(outputBasePath);
        return {
          status: "skipped",
          skipReason: transcriptionResult.hasBadTake ? "bad-take" : "transcript",
          logWritten,
        };
      }

      commandWindows = transcriptionResult.commandWindows;
      commandFilenameOverride = transcriptionResult.filenameOverride;
      hasEditCommand = transcriptionResult.hasEdit;
    }

    // Step 4: Determine final output path
    const outputTitle = commandFilenameOverride ?? chapter.title;
    const finalOutputPath = path.join(
      options.outputDir,
      `${formatChapterFilename({ ...chapter, title: outputTitle })}${path.extname(options.inputPath)}`,
    );

    // Step 5: Handle command splicing
    const spliceResult = await handleCommandSplicing({
      commandWindows,
      normalizedPath: paths.normalizedPath,
      rawDuration,
      tmpDir: options.tmpDir,
      outputBasePath,
      paths,
    });

    // Step 6: Detect speech bounds
    const speechBounds = await detectSpeechBounds(
      spliceResult.sourcePath,
      0,
      spliceResult.sourceDuration,
      spliceResult.sourceDuration,
    );

    let fallbackNote: string | undefined;
    let logWritten = false;
    if (speechBounds.note) {
      fallbackNote = speechBounds.note;
      logInfo(`Speech detection fallback: ${speechBounds.note}`);
      if (options.writeLogs) {
        await writeChapterLog(options.tmpDir, outputBasePath, [
          `Chapter: ${chapter.index + 1} - ${chapter.title}`,
          `Input: ${options.inputPath}`,
          `Reason: ${speechBounds.note}`,
        ]);
        logWritten = true;
      }
    }

    // Step 7: Apply speech padding
    const paddedStart = clamp(
      speechBounds.start - CONFIG.preSpeechPaddingSeconds,
      0,
      spliceResult.sourceDuration,
    );
    const paddedEnd = clamp(
      speechBounds.end + CONFIG.postSpeechPaddingSeconds,
      0,
      spliceResult.sourceDuration,
    );
    const trimmedDuration = paddedEnd - paddedStart;

    if (paddedEnd <= paddedStart + CONFIG.minTrimWindowSeconds) {
      throw new Error(
        `Trim window too small for "${chapter.title}" (${paddedStart}s -> ${paddedEnd}s)`,
      );
    }

    logInfo(
      `Speech bounds: ${formatSeconds(speechBounds.start)} -> ${formatSeconds(speechBounds.end)}, padded to ${formatSeconds(paddedStart)} -> ${formatSeconds(paddedEnd)}`,
    );

    // Step 8: Check trimmed duration
    if (trimmedDuration < options.minChapterDurationSeconds) {
      logInfo(
        `Skipping chapter ${chapter.index + 1}: trimmed ${formatSeconds(trimmedDuration)} < ${formatSeconds(options.minChapterDurationSeconds)}.`,
      );
      if (options.writeLogs) {
        await writeChapterLog(options.tmpDir, outputBasePath, [
          `Chapter: ${chapter.index + 1} - ${chapter.title}`,
          `Input: ${options.inputPath}`,
          `Duration: ${formatSeconds(duration)}`,
          `Trimmed duration: ${formatSeconds(trimmedDuration)}`,
          `Skip threshold: ${formatSeconds(options.minChapterDurationSeconds)}`,
          "Reason: Trimmed duration shorter than minimum duration threshold.",
        ]);
        logWritten = true;
      }
      await safeUnlink(outputBasePath);
      return { status: "skipped", skipReason: "short-trimmed", logWritten };
    }

    // Step 9: Write final output
    await extractChapterSegment({
      inputPath: spliceResult.sourcePath,
      outputPath: finalOutputPath,
      start: paddedStart,
      end: paddedEnd,
    });

    // Step 10: Verify no jarvis in final output
    let jarvisWarning: JarvisWarning | undefined;
    await extractTranscriptionAudio({
      inputPath: finalOutputPath,
      outputPath: paths.jarvisTranscriptionAudioPath,
      start: 0,
      end: trimmedDuration,
    });
    const jarvisTranscription = await transcribeAudio(
      paths.jarvisTranscriptionAudioPath,
      {
        modelPath: options.whisperModelPath,
        language: options.whisperLanguage,
        binaryPath: options.whisperBinaryPath,
        outputBasePath: paths.jarvisTranscriptionOutputBase,
      },
    );
    if (transcriptIncludesWord(jarvisTranscription.text, "jarvis")) {
      jarvisWarning = { chapter, outputPath: finalOutputPath };
      logWarn(
        `Jarvis detected in chapter ${chapter.index + 1}: ${path.basename(finalOutputPath)}`,
      );
    }

    // Step 11: Track edit commands
    let jarvisEdit: JarvisEdit | undefined;
    if (hasEditCommand) {
      jarvisEdit = { chapter, outputPath: finalOutputPath };
      logInfo(
        `Edit command detected for chapter ${chapter.index + 1}: ${path.basename(finalOutputPath)}`,
      );
    }

    return {
      status: "processed",
      jarvisWarning,
      jarvisEdit,
      fallbackNote,
      logWritten,
    };
  } finally {
    // Cleanup intermediate files
    if (!options.keepIntermediates) {
      await cleanupIntermediateFiles(paths);
    }
  }
}

interface IntermediatePaths {
  rawPath: string;
  normalizedPath: string;
  transcriptionAudioPath: string;
  transcriptionOutputBase: string;
  transcriptionTextPath: string;
  transcriptionJsonPath: string;
  jarvisTranscriptionAudioPath: string;
  jarvisTranscriptionOutputBase: string;
  jarvisTranscriptionTextPath: string;
  jarvisTranscriptionJsonPath: string;
  spliceSegmentPaths: string[];
  splicedPath: string | null;
}

function buildIntermediatePaths(
  tmpDir: string,
  outputBasePath: string,
): IntermediatePaths {
  const transcriptionOutputBase = buildTranscriptionOutputBase(
    tmpDir,
    outputBasePath,
  );
  const jarvisTranscriptionOutputBase = buildJarvisOutputBase(
    tmpDir,
    outputBasePath,
  );

  return {
    rawPath: buildIntermediatePath(tmpDir, outputBasePath, "raw"),
    normalizedPath: buildIntermediatePath(tmpDir, outputBasePath, "normalized"),
    transcriptionAudioPath: buildIntermediateAudioPath(
      tmpDir,
      outputBasePath,
      "transcribe",
    ),
    transcriptionOutputBase,
    transcriptionTextPath: `${transcriptionOutputBase}.txt`,
    transcriptionJsonPath: `${transcriptionOutputBase}.json`,
    jarvisTranscriptionAudioPath: buildIntermediateAudioPath(
      tmpDir,
      outputBasePath,
      "jarvis",
    ),
    jarvisTranscriptionOutputBase,
    jarvisTranscriptionTextPath: `${jarvisTranscriptionOutputBase}.txt`,
    jarvisTranscriptionJsonPath: `${jarvisTranscriptionOutputBase}.json`,
    spliceSegmentPaths: [],
    splicedPath: null,
  };
}

async function cleanupIntermediateFiles(paths: IntermediatePaths) {
  await safeUnlink(paths.rawPath);
  await safeUnlink(paths.normalizedPath);
  await safeUnlink(paths.transcriptionAudioPath);
  await safeUnlink(paths.transcriptionTextPath);
  await safeUnlink(paths.transcriptionJsonPath);
  await safeUnlink(paths.jarvisTranscriptionAudioPath);
  await safeUnlink(paths.jarvisTranscriptionTextPath);
  await safeUnlink(paths.jarvisTranscriptionJsonPath);
  if (paths.splicedPath) {
    await safeUnlink(paths.splicedPath);
  }
  for (const segmentPath of paths.spliceSegmentPaths) {
    await safeUnlink(segmentPath);
  }
}

interface TranscriptionAnalysisResult {
  commandWindows: TimeRange[];
  filenameOverride: string | null;
  hasEdit: boolean;
  hasBadTake: boolean;
  shouldSkip: boolean;
  skipReason?: string;
}

async function transcribeAndAnalyze(params: {
  normalizedPath: string;
  transcriptionAudioPath: string;
  transcriptionOutputBase: string;
  rawDuration: number;
  options: ChapterProcessingOptions;
}): Promise<TranscriptionAnalysisResult> {
  await extractTranscriptionAudio({
    inputPath: params.normalizedPath,
    outputPath: params.transcriptionAudioPath,
    start: 0,
    end: params.rawDuration,
  });

  const transcriptionResult = await transcribeAudio(
    params.transcriptionAudioPath,
    {
      modelPath: params.options.whisperModelPath,
      language: params.options.whisperLanguage,
      binaryPath: params.options.whisperBinaryPath,
      outputBasePath: params.transcriptionOutputBase,
    },
  );

  const transcript = transcriptionResult.text;
  const scaledSegments =
    transcriptionResult.segmentsSource === "tokens"
      ? transcriptionResult.segments
      : scaleTranscriptSegments(transcriptionResult.segments, params.rawDuration);

  const commands = extractTranscriptCommands(scaledSegments, {
    wakeWord: COMMAND_WAKE_WORD,
    closeWord: COMMAND_CLOSE_WORD,
  });

  if (commands.length > 0) {
    logInfo(`Commands detected: ${formatCommandTypes(commands)}`);
  }

  const analysis = analyzeCommands(commands, transcript);

  if (analysis.filenameOverride) {
    logInfo(`Filename command: ${analysis.filenameOverride}`);
  }

  if (analysis.shouldSkip) {
    logInfo(`Skipping: ${analysis.skipReason}`);
    return {
      commandWindows: [],
      filenameOverride: analysis.filenameOverride,
      hasEdit: analysis.hasEdit,
      hasBadTake: analysis.hasBadTake,
      shouldSkip: true,
      skipReason: analysis.skipReason,
    };
  }

  let commandWindows = buildCommandWindows(commands, {
    offset: 0,
    min: 0,
    max: params.rawDuration,
    paddingSeconds: CONFIG.commandTrimPaddingSeconds,
  });

  if (commandWindows.length > 0) {
    commandWindows = await refineCommandWindows({
      commandWindows,
      inputPath: params.normalizedPath,
      duration: params.rawDuration,
    });
  }

  return {
    commandWindows,
    filenameOverride: analysis.filenameOverride,
    hasEdit: analysis.hasEdit,
    hasBadTake: analysis.hasBadTake,
    shouldSkip: false,
  };
}

interface SpliceResult {
  sourcePath: string;
  sourceDuration: number;
}

async function handleCommandSplicing(params: {
  commandWindows: TimeRange[];
  normalizedPath: string;
  rawDuration: number;
  tmpDir: string;
  outputBasePath: string;
  paths: IntermediatePaths;
}): Promise<SpliceResult> {
  let sourcePath = params.normalizedPath;
  let sourceDuration = params.rawDuration;

  if (params.commandWindows.length === 0) {
    return { sourcePath, sourceDuration };
  }

  const mergedCommandWindows = mergeTimeRanges(params.commandWindows);
  const keepRanges = buildKeepRanges(
    0,
    params.rawDuration,
    mergedCommandWindows,
  );

  if (keepRanges.length === 0) {
    throw new Error("Command windows removed entire chapter.");
  }

  const isFullRange =
    keepRanges.length === 1 &&
    keepRanges[0] &&
    keepRanges[0].start <= 0.001 &&
    keepRanges[0].end >= params.rawDuration - 0.001;

  if (isFullRange) {
    return { sourcePath, sourceDuration };
  }

  // Check if command is at end - just trim instead of splicing
  const isCommandAtEnd =
    keepRanges.length === 1 && keepRanges[0] && keepRanges[0].start <= 0.001;

  if (isCommandAtEnd && keepRanges[0]) {
    sourceDuration = keepRanges[0].end;
    logInfo(`Command at end - trimming to ${formatSeconds(sourceDuration)}`);
    return { sourcePath, sourceDuration };
  }

  // Command mid-video - need to splice
  const splicedPath = buildIntermediatePath(
    params.tmpDir,
    params.outputBasePath,
    "spliced",
  );
  params.paths.splicedPath = splicedPath;

  const segmentsWithSpeech: { path: string; range: TimeRange }[] = [];

  for (const [index, range] of keepRanges.entries()) {
    const segmentPath = buildIntermediatePath(
      params.tmpDir,
      params.outputBasePath,
      `splice-${index + 1}`,
    );
    params.paths.spliceSegmentPaths.push(segmentPath);

    await extractChapterSegmentAccurate({
      inputPath: params.normalizedPath,
      outputPath: segmentPath,
      start: range.start,
      end: range.end,
    });

    // Check if segment has speech using VAD
    const segmentDuration = range.end - range.start;
    const hasSpeech = await checkSegmentHasSpeech(segmentPath, segmentDuration);

    if (hasSpeech) {
      segmentsWithSpeech.push({ path: segmentPath, range });
    } else {
      logInfo(
        `Splice segment ${index + 1} has no speech, excluding from combined output`,
      );
    }
  }

  if (segmentsWithSpeech.length === 0) {
    throw new Error("All splice segments have no speech.");
  }

  if (segmentsWithSpeech.length === 1 && segmentsWithSpeech[0]) {
    // Only one segment with speech - use it directly without concat
    sourcePath = segmentsWithSpeech[0].path;
    sourceDuration =
      segmentsWithSpeech[0].range.end - segmentsWithSpeech[0].range.start;
    params.paths.splicedPath = null; // Don't delete the segment we're using
    logInfo(
      `Using single segment with speech, duration: ${formatSeconds(sourceDuration)}`,
    );
  } else {
    await concatSegments({
      segmentPaths: segmentsWithSpeech.map((s) => s.path),
      outputPath: splicedPath,
    });
    sourcePath = splicedPath;
    sourceDuration = segmentsWithSpeech.reduce(
      (total, s) => total + (s.range.end - s.range.start),
      0,
    );
    logInfo(
      `Spliced ${segmentsWithSpeech.length} segments (of ${keepRanges.length}), combined duration: ${formatSeconds(sourceDuration)}`,
    );
  }

  return { sourcePath, sourceDuration };
}
