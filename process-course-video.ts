#!/usr/bin/env bun
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { ensureFfmpegAvailable, getChapters } from "./process-course/ffmpeg";
import { logInfo } from "./process-course/logging";
import { parseCliArgs } from "./process-course/cli";
import { resolveChapterSelection } from "./process-course/utils/chapter-selection";
import { removeDirIfEmpty } from "./process-course/utils/file-utils";
import { writeJarvisLogs, writeSummaryLogs } from "./process-course/summary";
import {
  processChapter,
  type ChapterProcessingOptions,
} from "./process-course/chapter-processor";
import type {
  JarvisEdit,
  JarvisNote,
  JarvisWarning,
  ProcessedChapterInfo,
  EditWorkspaceInfo,
} from "./process-course/types";
import { formatSeconds } from "./utils";
import { checkSegmentHasSpeech } from "./speech-detection";

interface ProcessingSummary {
  totalSelected: number;
  processed: number;
  skippedShortInitial: number;
  skippedShortTrimmed: number;
  skippedTranscription: number;
  fallbackNotes: number;
  logsWritten: number;
  jarvisWarnings: number;
  editsPending: number;
}

async function main() {
  const parsedArgs = parseCliArgs();
  if (parsedArgs.shouldExit) {
    return;
  }

  const {
    inputPaths,
    outputDir,
    minChapterDurationSeconds,
    dryRun,
    keepIntermediates,
    writeLogs,
    chapterSelection,
    enableTranscription,
    whisperModelPath,
    whisperLanguage,
    whisperBinaryPath,
  } = parsedArgs;

  await ensureFfmpegAvailable();

  // Process each input file in turn
  for (const inputPath of inputPaths) {
    // Determine output directory for this file
    let fileOutputDir: string;
    if (outputDir) {
      // If only one input file, use output directory as-is
      // Otherwise, create a subdirectory for each file
      fileOutputDir =
        inputPaths.length === 1
          ? outputDir
          : path.join(outputDir, path.parse(inputPath).name);
    } else {
      // Default: create directory next to input file
      fileOutputDir = path.join(
        path.dirname(inputPath),
        path.parse(inputPath).name,
      );
    }

    await processInputFile({
      inputPath,
      outputDir: fileOutputDir,
      minChapterDurationSeconds,
      dryRun,
      keepIntermediates,
      writeLogs,
      chapterSelection,
      enableTranscription,
      whisperModelPath,
      whisperLanguage,
      whisperBinaryPath,
    });
  }
}

async function processInputFile(options: {
  inputPath: string;
  outputDir: string;
  minChapterDurationSeconds: number;
  dryRun: boolean;
  keepIntermediates: boolean;
  writeLogs: boolean;
  chapterSelection: import("./process-course/types").ChapterSelection | null;
  enableTranscription: boolean;
  whisperModelPath: string;
  whisperLanguage: string;
  whisperBinaryPath: string | undefined;
}) {
  const {
    inputPath,
    outputDir,
    minChapterDurationSeconds,
    dryRun,
    keepIntermediates,
    writeLogs,
    chapterSelection,
    enableTranscription,
    whisperModelPath,
    whisperLanguage,
    whisperBinaryPath,
  } = options;

  const tmpDir = path.join(outputDir, ".tmp");

  const inputFile = Bun.file(inputPath);
  if (!(await inputFile.exists())) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  if (!dryRun) {
    await mkdir(outputDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
  }

  const chapters = await getChapters(inputPath);
  if (chapters.length === 0) {
    throw new Error("No chapters found. The input must contain chapters.");
  }

  const chapterIndexes = chapterSelection
    ? resolveChapterSelection(chapterSelection, chapters.length)
    : null;

  logStartupInfo({
    inputPath,
    chaptersCount: chapters.length,
    chapterIndexes,
    minChapterDurationSeconds,
    dryRun,
    keepIntermediates,
    writeLogs,
    enableTranscription,
    whisperModelPath,
    whisperLanguage,
    whisperBinaryPath,
  });

  chapters.forEach((chapter) => {
    logInfo(
      `- [${chapter.index + 1}] ${chapter.title} (${formatSeconds(chapter.start)} -> ${formatSeconds(chapter.end)})`,
    );
  });

  const selectedChapters = chapterIndexes
    ? chapters.filter((chapter) => chapterIndexes.includes(chapter.index))
    : chapters;

  const summary: ProcessingSummary = {
    totalSelected: selectedChapters.length,
    processed: 0,
    skippedShortInitial: 0,
    skippedShortTrimmed: 0,
    skippedTranscription: 0,
    fallbackNotes: 0,
    logsWritten: 0,
    jarvisWarnings: 0,
    editsPending: 0,
  };
  const summaryDetails: string[] = [];
  const jarvisWarnings: JarvisWarning[] = [];
  const jarvisEdits: JarvisEdit[] = [];
  const jarvisNotes: JarvisNote[] = [];
  const editWorkspaces: EditWorkspaceInfo[] = [];

  const processingOptions: ChapterProcessingOptions = {
    inputPath,
    outputDir,
    tmpDir,
    minChapterDurationSeconds,
    enableTranscription,
    whisperModelPath,
    whisperLanguage,
    whisperBinaryPath,
    keepIntermediates,
    writeLogs,
    dryRun,
  };

  // Track processed chapters that have speech (for combine logic)
  const processedChaptersWithSpeech: ProcessedChapterInfo[] = [];
  let previousProcessedChapter: ProcessedChapterInfo | null = null;

  for (const chapter of selectedChapters) {
    // Determine which chapter to combine with
    // Always use the most recent processed chapter with speech (if any)
    let chapterToCombineWith: ProcessedChapterInfo | null = null;
    if (processedChaptersWithSpeech.length > 0) {
      chapterToCombineWith =
        processedChaptersWithSpeech[processedChaptersWithSpeech.length - 1];
      // If previousProcessedChapter exists but is different, log that we're skipping it
      if (
        previousProcessedChapter &&
        previousProcessedChapter !== chapterToCombineWith
      ) {
        logInfo(
          `Previous chapter ${previousProcessedChapter.chapter.index + 1} has no speech. Using chapter ${chapterToCombineWith.chapter.index + 1} for combine instead.`,
        );
      }
    }

    const result = await processChapter(chapter, {
      ...processingOptions,
      previousProcessedChapter: chapterToCombineWith,
    });

    // Update summary based on result
    if (result.status === "processed") {
      summary.processed += 1;
    } else {
      switch (result.skipReason) {
        case "short-initial":
          summary.skippedShortInitial += 1;
          summaryDetails.push(
            `Skipped chapter ${chapter.index + 1} (${formatSeconds(chapter.end - chapter.start)} < ${formatSeconds(minChapterDurationSeconds)}).`,
          );
          break;
        case "short-trimmed":
          summary.skippedShortTrimmed += 1;
          summaryDetails.push(
            `Skipped chapter ${chapter.index + 1} (trimmed duration too short).`,
          );
          break;
        case "transcript":
        case "bad-take":
          summary.skippedTranscription += 1;
          summaryDetails.push(
            `Skipped chapter ${chapter.index + 1} (${result.skipReason}).`,
          );
          break;
        case "dry-run":
          // Dry run counts as processed
          break;
      }
    }

    if (result.logWritten) {
      summary.logsWritten += 1;
    }

    if (result.fallbackNote) {
      summary.fallbackNotes += 1;
      summaryDetails.push(
        `Fallback for chapter ${chapter.index + 1}: ${result.fallbackNote}`,
      );
    }

    if (result.jarvisWarning) {
      jarvisWarnings.push(result.jarvisWarning);
      summary.jarvisWarnings += 1;
    }

    if (result.jarvisEdit) {
      jarvisEdits.push(result.jarvisEdit);
    }

    if (result.jarvisNotes) {
      jarvisNotes.push(...result.jarvisNotes);
    }

    if (result.editWorkspace) {
      editWorkspaces.push(result.editWorkspace);
      summary.editsPending += 1;
    }

    // Update previous processed chapter for combine logic
    if (result.status === "processed" && result.processedInfo) {
      previousProcessedChapter = result.processedInfo;
      
      // If we combined with a chapter, the combined output replaces that chapter in the list
      if (chapterToCombineWith) {
        const combineIndex = processedChaptersWithSpeech.findIndex(
          (ch) => ch === chapterToCombineWith,
        );
        if (combineIndex >= 0) {
          // Replace the combined chapter with the new combined output
          processedChaptersWithSpeech[combineIndex] = result.processedInfo;
        } else {
          // Shouldn't happen, but if it does, add the combined result
          processedChaptersWithSpeech.push(result.processedInfo);
        }
      } else {
        // Not a combine - check if this chapter has speech and add to list if it does
        const hasSpeech = await checkSegmentHasSpeech(
          result.processedInfo.outputPath,
          result.processedInfo.processedDuration,
        );
        if (hasSpeech) {
          processedChaptersWithSpeech.push(result.processedInfo);
        }
      }
    }
  }

  // Always write jarvis logs (summary information)
  await writeJarvisLogs({
    outputDir,
    inputPath,
    jarvisWarnings,
    jarvisEdits,
    jarvisNotes,
    editWorkspaces,
    dryRun,
  });

  // Only write detailed summary log when writeLogs is enabled
  if (writeLogs) {
    await writeSummaryLogs({
      tmpDir,
      outputDir,
      inputPath,
      summary,
      summaryDetails,
      jarvisWarnings,
      jarvisEdits,
      editWorkspaces,
      dryRun,
    });
  }

  if (!dryRun) {
    await removeDirIfEmpty(tmpDir);
  }
}

function logStartupInfo(options: {
  inputPath: string;
  chaptersCount: number;
  chapterIndexes: number[] | null;
  minChapterDurationSeconds: number;
  dryRun: boolean;
  keepIntermediates: boolean;
  writeLogs: boolean;
  enableTranscription: boolean;
  whisperModelPath: string;
  whisperLanguage: string;
  whisperBinaryPath: string | undefined;
}) {
  logInfo(`Processing: ${options.inputPath}`);
  logInfo(`Chapters found: ${options.chaptersCount}`);
  if (options.chapterIndexes) {
    logInfo(
      `Filtering to chapters: ${options.chapterIndexes.map((index) => index + 1).join(", ")}`,
    );
  }
  logInfo(
    `Skipping chapters shorter than ${formatSeconds(options.minChapterDurationSeconds)}.`,
  );
  if (options.dryRun) {
    logInfo("Dry run enabled; no files will be written.");
  } else if (options.keepIntermediates) {
    logInfo("Keeping intermediate files for debugging.");
  }
  if (options.writeLogs) {
    logInfo("Writing log files for skipped/fallback cases.");
  }
  if (options.enableTranscription) {
    logInfo(
      `Whisper transcription enabled (model: ${options.whisperModelPath}, language: ${options.whisperLanguage}, binary: ${options.whisperBinaryPath}).`,
    );
  }
}

main().catch((error) => {
  console.error(`[error] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
