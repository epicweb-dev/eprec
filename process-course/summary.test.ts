import { test, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import {
  buildJarvisEditLogPath,
  buildJarvisWarningLogPath,
  buildSummaryLogPath,
} from "./paths";
import type { Chapter, JarvisEdit, JarvisWarning, TimeRange } from "./types";
import { writeJarvisLogs, writeSummaryLogs } from "./summary";

async function createTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "summary-logs-"));
}

function createChapter(index: number, title = `Chapter ${index + 1}`): Chapter {
  return { index, start: 0, end: 10, title };
}

function createTimestamp(start: number, end: number): TimeRange {
  return { start, end };
}

function createWarning(
  index: number,
  outputPath: string,
  timestamps: TimeRange[] = [],
): JarvisWarning {
  return { chapter: createChapter(index), outputPath, timestamps };
}

function createEdit(index: number, outputPath: string): JarvisEdit {
  return { chapter: createChapter(index), outputPath };
}

test("writeJarvisLogs writes warning and edit logs", async () => {
  const tmpDir = await createTempDir();
  const outputDir = path.join(tmpDir, "output");
  await mkdir(outputDir);
  try {
    const warning = createWarning(
      0,
      path.join(outputDir, "chapter-01.mp4"),
      [createTimestamp(1, 1.5), createTimestamp(4.25, 4.75)],
    );
    const edit = createEdit(1, path.join(outputDir, "chapter-02.mp4"));

    await writeJarvisLogs({
      outputDir,
      inputPath: "/videos/course.mp4",
      jarvisWarnings: [warning],
      jarvisEdits: [edit],
      jarvisNotes: [],
      dryRun: false,
    });

    const warningLog = await Bun.file(
      buildJarvisWarningLogPath(outputDir),
    ).text();
    expect(warningLog).toContain("Input: /videos/course.mp4");
    expect(warningLog).toContain("Jarvis warnings: 1");
    expect(warningLog).toContain("Detected in:");
    expect(warningLog).toContain("Chapter 1");
    expect(warningLog).toContain("chapter-01.mp4");
    expect(warningLog).toContain(
      "Jarvis timestamps: 1.00s-1.50s, 4.25s-4.75s",
    );

    const editLog = await Bun.file(buildJarvisEditLogPath(outputDir)).text();
    expect(editLog).toContain("Input: /videos/course.mp4");
    expect(editLog).toContain("Edit commands: 1");
    expect(editLog).toContain("Files needing edits:");
    expect(editLog).toContain("Chapter 2");
    expect(editLog).toContain("chapter-02.mp4");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeJarvisLogs handles empty warning and edit lists", async () => {
  const tmpDir = await createTempDir();
  const outputDir = path.join(tmpDir, "output");
  await mkdir(outputDir);
  try {
    await writeJarvisLogs({
      outputDir,
      inputPath: "/videos/course.mp4",
      jarvisWarnings: [],
      jarvisEdits: [],
      jarvisNotes: [],
      dryRun: false,
    });

    const warningLog = await Bun.file(
      buildJarvisWarningLogPath(outputDir),
    ).text();
    expect(warningLog).toContain("Detected in: none");

    const editLog = await Bun.file(buildJarvisEditLogPath(outputDir)).text();
    expect(editLog).toContain("Files needing edits: none");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeSummaryLogs writes summary file with details", async () => {
  const tmpDir = await createTempDir();
  const outputDir = path.join(tmpDir, "output");
  await mkdir(outputDir);
  try {
    await writeSummaryLogs({
      tmpDir,
      outputDir,
      inputPath: "/videos/course.mp4",
      summary: {
        totalSelected: 3,
        processed: 2,
        skippedShortInitial: 0,
        skippedShortTrimmed: 1,
        skippedTranscription: 0,
        fallbackNotes: 1,
        logsWritten: 2,
        jarvisWarnings: 0,
      },
      summaryDetails: ["- Chapter 2 skipped (short)"],
      jarvisWarnings: [],
      jarvisEdits: [],
      dryRun: false,
    });

    const summaryLog = await Bun.file(buildSummaryLogPath(tmpDir)).text();
    expect(summaryLog).toContain("Input: /videos/course.mp4");
    expect(summaryLog).toContain("Processed chapters: 2");
    expect(summaryLog).toContain("Details:");
    expect(summaryLog).toContain("- Chapter 2 skipped (short)");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeSummaryLogs skips writing file in dry run mode", async () => {
  const tmpDir = await createTempDir();
  const outputDir = path.join(tmpDir, "output");
  await mkdir(outputDir);
  try {
    await writeSummaryLogs({
      tmpDir,
      outputDir,
      inputPath: "/videos/course.mp4",
      summary: {
        totalSelected: 1,
        processed: 1,
        skippedShortInitial: 0,
        skippedShortTrimmed: 0,
        skippedTranscription: 0,
        fallbackNotes: 0,
        logsWritten: 0,
        jarvisWarnings: 0,
      },
      summaryDetails: [],
      jarvisWarnings: [],
      jarvisEdits: [],
      dryRun: true,
    });

    expect(await Bun.file(buildSummaryLogPath(tmpDir)).exists()).toBe(false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
