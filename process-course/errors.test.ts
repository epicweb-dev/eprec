import { test, expect } from "bun:test";
import {
  BadTakeError,
  ChapterProcessingError,
  ChapterTooShortError,
  CommandParseError,
  SpliceError,
  TranscriptTooShortError,
  TrimWindowError,
} from "./errors";

test("ChapterProcessingError exposes metadata", () => {
  const error = new ChapterProcessingError("Failed", 2, "Intro");
  expect(error.name).toBe("ChapterProcessingError");
  expect(error.message).toBe("Failed");
  expect(error.chapterIndex).toBe(2);
  expect(error.chapterTitle).toBe("Intro");
});

test("ChapterTooShortError formats message with duration", () => {
  const error = new ChapterTooShortError(1, "Basics", 4.1234, 5);
  expect(error.name).toBe("ChapterTooShortError");
  expect(error.message).toBe('Chapter "Basics" is too short (4.12s < 5s)');
  expect(error.duration).toBe(4.1234);
  expect(error.minDuration).toBe(5);
});

test("CommandParseError stores transcript context", () => {
  const error = new CommandParseError("Bad command", "Jarvis bad take");
  expect(error.name).toBe("CommandParseError");
  expect(error.message).toBe("Bad command");
  expect(error.transcript).toBe("Jarvis bad take");
});

test("TranscriptTooShortError formats message with word count", () => {
  const error = new TranscriptTooShortError(0, "Intro", 5, 10);
  expect(error.name).toBe("TranscriptTooShortError");
  expect(error.message).toBe(
    'Chapter "Intro" transcript too short (5 words < 10)',
  );
  expect(error.wordCount).toBe(5);
  expect(error.minWordCount).toBe(10);
});

test("BadTakeError sets name and message", () => {
  const error = new BadTakeError(3, "Outro");
  expect(error.name).toBe("BadTakeError");
  expect(error.message).toBe('Chapter "Outro" marked as bad take');
});

test("SpliceError uses custom name", () => {
  const error = new SpliceError("Failed to splice");
  expect(error.name).toBe("SpliceError");
  expect(error.message).toBe("Failed to splice");
});

test("TrimWindowError formats message with precision", () => {
  const error = new TrimWindowError(1.23456, 1.23999);
  expect(error.name).toBe("TrimWindowError");
  expect(error.message).toBe("Trim window too small (1.235s -> 1.240s)");
  expect(error.start).toBe(1.23456);
  expect(error.end).toBe(1.23999);
});
