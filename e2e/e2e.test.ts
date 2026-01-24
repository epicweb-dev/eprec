import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";
import {
  buildJarvisEditLogPath,
  buildJarvisWarningLogPath,
  buildJarvisNoteLogPath,
} from "../process-course/paths";
import { extractTranscriptionAudio } from "../process-course/ffmpeg";
import { transcriptIncludesWord } from "../process-course/utils/transcript";
import { transcribeAudio } from "../whispercpp-transcribe";
import { runCommand } from "../utils";

const TEST_OUTPUT_DIR = path.join(process.cwd(), ".test-output", "e2e-test");
const TEST_TRANSCRIPT_DIR = path.join(
  TEST_OUTPUT_DIR,
  ".tmp",
  "e2e-transcripts",
);
const FIXTURE_PATH = path.resolve("fixtures/e2e-test.mp4");

// Helper to check if file exists
async function fileExists(filePath: string): Promise<boolean> {
  const file = Bun.file(filePath);
  return file.exists();
}

// Helper to read file contents
async function readFile(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  return file.text();
}

// Helper to list files in directory with extension filter
async function listFiles(dir: string, ext?: string): Promise<string[]> {
  const glob = new Bun.Glob(ext ? `*${ext}` : "*");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
    files.push(file);
  }
  return files.sort();
}

function createExpectedWords(...words: string[]): string[] {
  return words;
}

async function ensureTranscriptDir(): Promise<string> {
  await mkdir(TEST_TRANSCRIPT_DIR, { recursive: true });
  return TEST_TRANSCRIPT_DIR;
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

async function transcribeOutputVideo(outputPath: string): Promise<string> {
  const transcriptDir = await ensureTranscriptDir();
  const baseName = path.parse(outputPath).name;
  const audioPath = path.join(transcriptDir, `${baseName}-output.wav`);
  const outputBasePath = path.join(
    transcriptDir,
    `${baseName}-output-transcript`,
  );
  const duration = await getMediaDurationSeconds(outputPath);
  await extractTranscriptionAudio({
    inputPath: outputPath,
    outputPath: audioPath,
    start: 0,
    end: duration,
  });
  const transcript = await transcribeAudio(audioPath, { outputBasePath });
  return transcript.text;
}

function expectTranscriptIncludesWords(
  transcript: string,
  expectedWords: string[],
) {
  for (const word of expectedWords) {
    expect(transcriptIncludesWord(transcript, word)).toBe(true);
  }
}

beforeAll(async () => {
  // Clean up any previous test output
  await rm(TEST_OUTPUT_DIR, { recursive: true, force: true });

  // Run the full pipeline
  const result =
    await $`bun process-course-video.ts ${FIXTURE_PATH} ${TEST_OUTPUT_DIR} --min-chapter-seconds 2 -k`.quiet();

  if (result.exitCode !== 0) {
    console.error("Pipeline failed:", result.stderr.toString());
    throw new Error(`Pipeline exited with code ${result.exitCode}`);
  }
}, 300000); // 5 minute timeout for processing

afterAll(async () => {
  await rm(TEST_OUTPUT_DIR, { recursive: true, force: true });
});

// =============================================================================
// Output File Tests
// =============================================================================

test("e2e produces exactly 7 output video files", async () => {
  const mp4Files = await listFiles(TEST_OUTPUT_DIR, ".mp4");
  expect(mp4Files).toHaveLength(7);
});

test("e2e produces expected output filenames", async () => {
  const mp4Files = await listFiles(TEST_OUTPUT_DIR, ".mp4");

  expect(mp4Files).toEqual([
    "chapter-01-start.mp4",
    "chapter-03-custom-output.mp4",
    "chapter-04-unnamed-3.mp4",
    "chapter-05-unnamed-4.mp4",
    "chapter-06-unnamed-5.mp4",
    "chapter-07-unnamed-6.mp4",
    "chapter-10-unnamed-9.mp4",
  ]);
});

// =============================================================================
// Chapter 1: Normal Processing
// =============================================================================

test("e2e chapter 1 processes normally without commands", async () => {
  const outputPath = path.join(TEST_OUTPUT_DIR, "chapter-01-start.mp4");
  const exists = await fileExists(outputPath);
  expect(exists).toBe(true);
});

// =============================================================================
// Chapter 2: Bad Take (should be skipped)
// =============================================================================

test("e2e chapter 2 is skipped due to bad-take command", async () => {
  // Chapter 2 should not produce an output file
  const mp4Files = await listFiles(TEST_OUTPUT_DIR, ".mp4");
  const chapter2Files = mp4Files.filter((f) => f.startsWith("chapter-02"));
  expect(chapter2Files).toHaveLength(0);
});

// =============================================================================
// Chapter 3: Filename Override
// =============================================================================

test("e2e chapter 3 uses custom filename from filename command", async () => {
  const outputPath = path.join(TEST_OUTPUT_DIR, "chapter-03-custom-output.mp4");
  const exists = await fileExists(outputPath);
  expect(exists).toBe(true);
});

// =============================================================================
// Chapter 4: Edit Flag
// =============================================================================

test("e2e chapter 4 processes and is logged for editing", async () => {
  const outputPath = path.join(TEST_OUTPUT_DIR, "chapter-04-unnamed-3.mp4");
  const exists = await fileExists(outputPath);
  expect(exists).toBe(true);
});

test("e2e jarvis-edits.log contains chapter 4", async () => {
  const editLogPath = buildJarvisEditLogPath(TEST_OUTPUT_DIR);
  const content = await readFile(editLogPath);

  expect(content).toContain("Edit commands: 1");
  expect(content).toContain("Chapter 4: Unnamed 3");
  expect(content).toContain("chapter-04-unnamed-3.mp4");
});

// =============================================================================
// Chapter 5: Note Command
// =============================================================================

test("e2e chapter 5 processes and note is logged", async () => {
  const outputPath = path.join(TEST_OUTPUT_DIR, "chapter-05-unnamed-4.mp4");
  const exists = await fileExists(outputPath);
  expect(exists).toBe(true);
});

test("e2e jarvis-notes.log contains chapter 5 note", async () => {
  const noteLogPath = buildJarvisNoteLogPath(TEST_OUTPUT_DIR);
  const content = await readFile(noteLogPath);

  expect(content).toContain("Note commands: 1");
  expect(content).toContain("Chapter 5: Unnamed 4");
  expect(content).toContain("chapter-05-unnamed-4.mp4");
  expect(content).toContain("remember to add graphics here");
});

// =============================================================================
// Chapter 6: Nevermind Cancellation
// =============================================================================

test("e2e chapter 6 processes with nevermind command removed", async () => {
  const outputPath = path.join(TEST_OUTPUT_DIR, "chapter-06-unnamed-5.mp4");
  const exists = await fileExists(outputPath);
  expect(exists).toBe(true);
});

// =============================================================================
// Chapter 7 + 8: Split Base + Combine Previous
// =============================================================================

test("e2e chapter 7 and 8 are combined into single output", async () => {
  // Chapter 7 should exist (with chapter 8 combined into it)
  const chapter7Path = path.join(TEST_OUTPUT_DIR, "chapter-07-unnamed-6.mp4");
  const chapter7Exists = await fileExists(chapter7Path);
  expect(chapter7Exists).toBe(true);

  // Chapter 8 should NOT have a separate output file
  const mp4Files = await listFiles(TEST_OUTPUT_DIR, ".mp4");
  const chapter8Files = mp4Files.filter((f) => f.startsWith("chapter-08"));
  expect(chapter8Files).toHaveLength(0);
});

test("e2e combined chapter retains chapter 7 speech content", async () => {
  const chapter7Path = path.join(TEST_OUTPUT_DIR, "chapter-07-unnamed-6.mp4");
  const transcript = await transcribeOutputVideo(chapter7Path);
  expectTranscriptIncludesWords(
    transcript,
    createExpectedWords("split", "test"),
  );
});

// =============================================================================
// Chapter 9: Too Short
// =============================================================================

test("e2e chapter 9 is skipped due to short transcript", async () => {
  // Chapter 9 should not produce an output file
  const mp4Files = await listFiles(TEST_OUTPUT_DIR, ".mp4");
  const chapter9Files = mp4Files.filter((f) => f.startsWith("chapter-09"));
  expect(chapter9Files).toHaveLength(0);
});

// =============================================================================
// Chapter 10: New Chapter (Split) Command
// =============================================================================

test("e2e chapter 10 processes with split command", async () => {
  const outputPath = path.join(TEST_OUTPUT_DIR, "chapter-10-unnamed-9.mp4");
  const exists = await fileExists(outputPath);
  expect(exists).toBe(true);
});

// =============================================================================
// Chapter 11: Extra Blank Chapter (should be skipped)
// =============================================================================

test("e2e chapter 11 is skipped due to blank audio", async () => {
  // Chapter 11 should not produce an output file
  const mp4Files = await listFiles(TEST_OUTPUT_DIR, ".mp4");
  const chapter11Files = mp4Files.filter((f) => f.startsWith("chapter-11"));
  expect(chapter11Files).toHaveLength(0);
});

// =============================================================================
// Jarvis Warning Log
// =============================================================================

test("e2e jarvis-warnings.log shows no jarvis detected", async () => {
  const warningLogPath = buildJarvisWarningLogPath(TEST_OUTPUT_DIR);
  const content = await readFile(warningLogPath);

  expect(content).toContain("Jarvis warnings: 0");
  expect(content).toContain("Detected in: none");
});

// =============================================================================
// All Log Files Exist
// =============================================================================

test("e2e produces all expected log files", async () => {
  const warningLogExists = await fileExists(
    buildJarvisWarningLogPath(TEST_OUTPUT_DIR),
  );
  const editLogExists = await fileExists(
    buildJarvisEditLogPath(TEST_OUTPUT_DIR),
  );
  const noteLogExists = await fileExists(
    buildJarvisNoteLogPath(TEST_OUTPUT_DIR),
  );

  expect(warningLogExists).toBe(true);
  expect(editLogExists).toBe(true);
  expect(noteLogExists).toBe(true);
});

// =============================================================================
// Intermediate Files (with -k flag)
// =============================================================================

test("e2e keeps intermediate files in .tmp directory", async () => {
  const tmpDir = path.join(TEST_OUTPUT_DIR, ".tmp");

  // Should have transcription files for processed chapters
  const wavFiles = await listFiles(tmpDir, ".wav");
  expect(wavFiles.length).toBeGreaterThan(0);

  // Should have intermediate video files
  const mp4Files = await listFiles(tmpDir, ".mp4");
  expect(mp4Files.length).toBeGreaterThan(0);
});
