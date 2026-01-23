import path from "node:path";
import { buildSummaryLogPath, buildJarvisWarningLogPath, buildJarvisEditLogPath } from "./paths";
import { logInfo } from "./logging";
import type { Chapter, JarvisWarning, JarvisEdit } from "./types";

export type ProcessingSummary = {
  totalSelected: number;
  processed: number;
  skippedShortInitial: number;
  skippedShortTrimmed: number;
  skippedTranscription: number;
  fallbackNotes: number;
  logsWritten: number;
  jarvisWarnings: number;
};

export async function writeJarvisLogs(options: {
  outputDir: string;
  inputPath: string;
  jarvisWarnings: JarvisWarning[];
  jarvisEdits: JarvisEdit[];
  dryRun: boolean;
}) {
  const { outputDir, inputPath, jarvisWarnings, jarvisEdits, dryRun } = options;

  const jarvisWarningLogPath = buildJarvisWarningLogPath(outputDir);
  if (dryRun) {
    logInfo(`[dry-run] Would write jarvis warning log: ${jarvisWarningLogPath}`);
  } else {
    const warningLines = [
      `Input: ${inputPath}`,
      `Output dir: ${outputDir}`,
      `Jarvis warnings: ${jarvisWarnings.length}`,
    ];
    if (jarvisWarnings.length > 0) {
      warningLines.push("Detected in:");
      jarvisWarnings.forEach((warning) => {
        warningLines.push(
          `- Chapter ${warning.chapter.index + 1}: ${warning.chapter.title} -> ${path.basename(
            warning.outputPath,
          )}`,
        );
      });
    } else {
      warningLines.push("Detected in: none");
    }
    await Bun.write(jarvisWarningLogPath, `${warningLines.join("\n")}\n`);
  }

  const jarvisEditLogPath = buildJarvisEditLogPath(outputDir);
  if (dryRun) {
    logInfo(`[dry-run] Would write jarvis edit log: ${jarvisEditLogPath}`);
  } else {
    const editLines = [
      `Input: ${inputPath}`,
      `Output dir: ${outputDir}`,
      `Edit commands: ${jarvisEdits.length}`,
    ];
    if (jarvisEdits.length > 0) {
      editLines.push("Files needing edits:");
      jarvisEdits.forEach((edit) => {
        editLines.push(
          `- Chapter ${edit.chapter.index + 1}: ${edit.chapter.title} -> ${path.basename(
            edit.outputPath,
          )}`,
        );
      });
    } else {
      editLines.push("Files needing edits: none");
    }
    await Bun.write(jarvisEditLogPath, `${editLines.join("\n")}\n`);
  }
}

export async function writeSummaryLogs(options: {
  tmpDir: string;
  outputDir: string;
  inputPath: string;
  summary: ProcessingSummary;
  summaryDetails: string[];
  jarvisWarnings: JarvisWarning[];
  jarvisEdits: JarvisEdit[];
  dryRun: boolean;
}) {
  const {
    tmpDir,
    outputDir,
    inputPath,
    summary,
    summaryDetails,
    jarvisWarnings,
    jarvisEdits,
    dryRun,
  } = options;

  const summaryLines = [
    `Input: ${inputPath}`,
    `Output dir: ${outputDir}`,
    `Chapters selected: ${summary.totalSelected}`,
    `${dryRun ? "Would process" : "Processed"} chapters: ${summary.processed}`,
    `Skipped (short initial): ${summary.skippedShortInitial}`,
    `Skipped (trimmed short): ${summary.skippedShortTrimmed}`,
    `Skipped (transcription): ${summary.skippedTranscription}`,
    `Fallback notes: ${summary.fallbackNotes}`,
    `Log files written: ${summary.logsWritten}`,
    `Jarvis warnings: ${summary.jarvisWarnings}`,
  ];
  if (summaryDetails.length > 0) {
    summaryLines.push("Details:", ...summaryDetails);
  }

  logInfo("Summary:");
  summaryLines.forEach((line) => logInfo(line));

  if (dryRun) {
    const summaryLogPath = buildSummaryLogPath(tmpDir);
    logInfo(`[dry-run] Would write summary log: ${summaryLogPath}`);
  } else {
    const summaryLogPath = buildSummaryLogPath(tmpDir);
    await Bun.write(summaryLogPath, `${summaryLines.join("\n")}\n`);
  }
}
