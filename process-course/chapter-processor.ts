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
import { findSilenceBoundary } from "./jarvis-commands/windows";
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
import type { Chapter, TimeRange, JarvisWarning, JarvisEdit, ProcessedChapterInfo } from "./types";

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
  previousProcessedChapter?: ProcessedChapterInfo | null;
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
  processedInfo?: ProcessedChapterInfo;
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

      // Handle combine-previous command
      if (transcriptionResult.hasCombinePrevious) {
        if (!options.previousProcessedChapter) {
          logWarn(
            `Combine previous command detected for chapter ${chapter.index + 1}, but no previous chapter available. Processing normally.`,
          );
        } else {
          return await handleCombinePrevious({
            chapter,
            previousProcessedChapter: options.previousProcessedChapter,
            commandWindows,
            normalizedPath: paths.normalizedPath,
            rawDuration,
            tmpDir: options.tmpDir,
            outputBasePath,
            paths,
            options,
          });
        }
      }
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

    const processedInfo: ProcessedChapterInfo = {
      chapter,
      outputPath: finalOutputPath,
      processedPath: finalOutputPath, // Use output path as processed path (intermediates may be cleaned up)
      processedDuration: trimmedDuration,
    };

    return {
      status: "processed",
      jarvisWarning,
      jarvisEdit,
      fallbackNote,
      logWritten,
      processedInfo,
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
  hasCombinePrevious: boolean;
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
      hasCombinePrevious: analysis.hasCombinePrevious,
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
    hasCombinePrevious: analysis.hasCombinePrevious,
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

async function handleCombinePrevious(params: {
  chapter: Chapter;
  previousProcessedChapter: ProcessedChapterInfo;
  commandWindows: TimeRange[];
  normalizedPath: string;
  rawDuration: number;
  tmpDir: string;
  outputBasePath: string;
  paths: IntermediatePaths;
  options: ChapterProcessingOptions;
}): Promise<ChapterProcessingResult> {
  const {
    chapter,
    previousProcessedChapter,
    commandWindows,
    normalizedPath,
    rawDuration,
    tmpDir,
    outputBasePath,
    paths,
    options,
  } = params;

  logInfo(
    `Combining chapter ${chapter.index + 1} with previous chapter ${previousProcessedChapter.chapter.index + 1}`,
  );

  // Step 1: Remove combine-previous command window from current chapter
  const spliceResult = await handleCommandSplicing({
    commandWindows,
    normalizedPath,
    rawDuration,
    tmpDir,
    outputBasePath,
    paths,
  });

  // Step 2: Detect speech bounds on current chapter (after splicing)
  const currentSpeechBounds = await detectSpeechBounds(
    spliceResult.sourcePath,
    0,
    spliceResult.sourceDuration,
    spliceResult.sourceDuration,
  );

  // Step 3: Trim end of previous chapter's output
  // Load the previous chapter's output and detect speech bounds on the end portion
  const previousOutputDuration = previousProcessedChapter.processedDuration;
  const endSearchWindow = Math.min(
    previousOutputDuration * 0.3, // Search last 30% of previous chapter
    CONFIG.commandSilenceSearchSeconds * 2, // Or up to 2x the silence search window
  );
  const previousEndSearchStart = Math.max(
    0,
    previousOutputDuration - endSearchWindow,
  );

  // Detect speech bounds on the end portion
  const previousEndSpeechBounds = await detectSpeechBounds(
    previousProcessedChapter.outputPath,
    previousEndSearchStart,
    previousOutputDuration,
    previousOutputDuration,
  );

  // Find silence boundary before the end of speech
  const previousTrimEnd = await findSilenceBoundary({
    inputPath: previousProcessedChapter.outputPath,
    duration: previousOutputDuration,
    targetTime: previousEndSpeechBounds.end,
    direction: "before",
    maxSearchSeconds: CONFIG.commandSilenceSearchSeconds,
  });

  const finalPreviousEnd = previousTrimEnd ?? previousEndSpeechBounds.end;

  // Step 4: Trim start of current chapter at silence boundary
  const currentTrimStart = await findSilenceBoundary({
    inputPath: spliceResult.sourcePath,
    duration: spliceResult.sourceDuration,
    targetTime: currentSpeechBounds.start,
    direction: "after",
    maxSearchSeconds: CONFIG.commandSilenceSearchSeconds,
  });

  const finalCurrentStart = currentTrimStart ?? currentSpeechBounds.start;

  // Apply padding
  const previousPaddedEnd = clamp(
    finalPreviousEnd - CONFIG.postSpeechPaddingSeconds,
    0,
    previousOutputDuration,
  );
  const currentPaddedStart = clamp(
    finalCurrentStart - CONFIG.preSpeechPaddingSeconds,
    0,
    spliceResult.sourceDuration,
  );
  const currentPaddedEnd = clamp(
    currentSpeechBounds.end + CONFIG.postSpeechPaddingSeconds,
    0,
    spliceResult.sourceDuration,
  );

  logInfo(
    `Previous chapter trim: ${formatSeconds(previousPaddedEnd)} (from ${formatSeconds(previousOutputDuration)})`,
  );
  logInfo(
    `Current chapter trim: ${formatSeconds(currentPaddedStart)} -> ${formatSeconds(currentPaddedEnd)}`,
  );

  // Step 5: Extract trimmed segments
  const previousTrimmedPath = buildIntermediatePath(
    tmpDir,
    outputBasePath,
    "previous-trimmed",
  );
  await extractChapterSegmentAccurate({
    inputPath: previousProcessedChapter.outputPath,
    outputPath: previousTrimmedPath,
    start: 0,
    end: previousPaddedEnd,
  });

  const currentTrimmedPath = buildIntermediatePath(
    tmpDir,
    outputBasePath,
    "current-trimmed",
  );
  await extractChapterSegmentAccurate({
    inputPath: spliceResult.sourcePath,
    outputPath: currentTrimmedPath,
    start: currentPaddedStart,
    end: currentPaddedEnd,
  });

  // Step 6: Check if segments have speech
  const previousDuration = previousPaddedEnd;
  const currentDuration = currentPaddedEnd - currentPaddedStart;
  const previousHasSpeech = await checkSegmentHasSpeech(
    previousTrimmedPath,
    previousDuration,
  );
  const currentHasSpeech = await checkSegmentHasSpeech(
    currentTrimmedPath,
    currentDuration,
  );

  if (!previousHasSpeech || !currentHasSpeech) {
    throw new Error(
      `Cannot combine: ${!previousHasSpeech ? "previous" : "current"} segment has no speech.`,
    );
  }

  // Step 7: Delete old previous chapter output and concatenate segments to final path
  const finalOutputPath = previousProcessedChapter.outputPath;
  await safeUnlink(finalOutputPath);
  
  const combinedDuration = previousDuration + currentDuration;
  await concatSegments({
    segmentPaths: [previousTrimmedPath, currentTrimmedPath],
    outputPath: finalOutputPath,
  });

  logInfo(
    `Combined output written to ${path.basename(finalOutputPath)} (${formatSeconds(combinedDuration)})`,
  );

  // Step 9: Cleanup intermediate files
  await safeUnlink(previousTrimmedPath);
  await safeUnlink(currentTrimmedPath);

  // Step 10: Verify no jarvis in final output
  let jarvisWarning: JarvisWarning | undefined;
  const jarvisTranscriptionAudioPath = buildIntermediateAudioPath(
    tmpDir,
    outputBasePath,
    "jarvis-combined",
  );
  await extractTranscriptionAudio({
    inputPath: finalOutputPath,
    outputPath: jarvisTranscriptionAudioPath,
    start: 0,
    end: combinedDuration,
  });
  const jarvisTranscription = await transcribeAudio(
    jarvisTranscriptionAudioPath,
    {
      modelPath: options.whisperModelPath,
      language: options.whisperLanguage,
      binaryPath: options.whisperBinaryPath,
      outputBasePath: buildJarvisOutputBase(tmpDir, outputBasePath),
    },
  );
  if (transcriptIncludesWord(jarvisTranscription.text, "jarvis")) {
    jarvisWarning = {
      chapter: previousProcessedChapter.chapter,
      outputPath: finalOutputPath,
    };
    logWarn(
      `Jarvis detected in combined chapter: ${path.basename(finalOutputPath)}`,
    );
  }

  if (!options.keepIntermediates) {
    await safeUnlink(jarvisTranscriptionAudioPath);
  }

  // Return combined chapter info (using previous chapter's info but with updated duration)
  const processedInfo: ProcessedChapterInfo = {
    chapter: previousProcessedChapter.chapter,
    outputPath: finalOutputPath,
    processedPath: finalOutputPath,
    processedDuration: combinedDuration,
  };

  return {
    status: "processed",
    jarvisWarning,
    logWritten: false,
    processedInfo,
  };
}
