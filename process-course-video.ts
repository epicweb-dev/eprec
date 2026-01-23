#!/usr/bin/env bun
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { ensureFfmpegAvailable, getChapters } from "./process-course/ffmpeg";
import { logInfo } from "./process-course/logging";
import { parseCliArgs } from "./process-course/cli";
import { resolveChapterSelection } from "./process-course/utils/chapter-selection";
import { writeJarvisLogs, writeSummaryLogs } from "./process-course/summary";
import {
  processChapter,
  type ChapterProcessingOptions,
} from "./process-course/chapter-processor";
import type { JarvisEdit, JarvisWarning } from "./process-course/types";
import { formatSeconds } from "./utils";

interface ProcessingSummary {
  totalSelected: number;
  processed: number;
  skippedShortInitial: number;
  skippedShortTrimmed: number;
  skippedTranscription: number;
  fallbackNotes: number;
  logsWritten: number;
  jarvisWarnings: number;
}

async function main() {
  const parsedArgs = parseCliArgs();
  if (parsedArgs.shouldExit) {
    return;
  }

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
  } = parsedArgs;
  const tmpDir = path.join(outputDir, ".tmp");

  const inputFile = Bun.file(inputPath);
  if (!(await inputFile.exists())) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  await ensureFfmpegAvailable();
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
  };
  const summaryDetails: string[] = [];
  const jarvisWarnings: JarvisWarning[] = [];
  const jarvisEdits: JarvisEdit[] = [];

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

  for (const chapter of selectedChapters) {
    const result = await processChapter(chapter, processingOptions);

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
  }

  // Always write jarvis logs (summary information)
  await writeJarvisLogs({
    outputDir,
    inputPath,
    jarvisWarnings,
    jarvisEdits,
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
      dryRun,
    });
  }
}

function logStartupInfo(options: {
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
