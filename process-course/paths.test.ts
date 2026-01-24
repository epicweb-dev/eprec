import path from "node:path";
import { test, expect } from "bun:test";
import {
  buildChapterLogPath,
  buildIntermediateAudioPath,
  buildIntermediatePath,
  buildJarvisEditLogPath,
  buildJarvisOutputBase,
  buildJarvisWarningLogPath,
  buildSummaryLogPath,
  buildTranscriptionOutputBase,
} from "./paths";

test("buildIntermediatePath appends suffix with original extension", () => {
  const result = buildIntermediatePath(
    "/tmp",
    "/videos/lesson.mp4",
    "trimmed",
  );
  expect(result).toBe(path.join("/tmp", "lesson-trimmed.mp4"));
});

test("buildIntermediateAudioPath forces wav extension", () => {
  const result = buildIntermediateAudioPath(
    "/tmp",
    "/videos/lesson.mp4",
    "speech",
  );
  expect(result).toBe(path.join("/tmp", "lesson-speech.wav"));
});

test("buildTranscriptionOutputBase appends transcribe suffix", () => {
  const result = buildTranscriptionOutputBase("/tmp", "/videos/lesson.mp4");
  expect(result).toBe(path.join("/tmp", "lesson-transcribe"));
});

test("buildJarvisOutputBase appends jarvis suffix", () => {
  const result = buildJarvisOutputBase("/tmp", "/videos/lesson.mp4");
  expect(result).toBe(path.join("/tmp", "lesson-jarvis"));
});

test("buildSummaryLogPath uses process-summary.log", () => {
  expect(buildSummaryLogPath("/tmp")).toBe(
    path.join("/tmp", "process-summary.log"),
  );
});

test("buildJarvisWarningLogPath uses jarvis-warnings.log", () => {
  expect(buildJarvisWarningLogPath("/out")).toBe(
    path.join("/out", "jarvis-warnings.log"),
  );
});

test("buildJarvisEditLogPath uses jarvis-edits.log", () => {
  expect(buildJarvisEditLogPath("/out")).toBe(
    path.join("/out", "jarvis-edits.log"),
  );
});

test("buildChapterLogPath uses output filename for log", () => {
  const result = buildChapterLogPath("/tmp", "/videos/lesson.mp4");
  expect(result).toBe(path.join("/tmp", "lesson.log"));
});
