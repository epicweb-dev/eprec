import { test, expect } from "bun:test";
import {
  countTranscriptWords,
  transcriptIncludesWord,
  normalizeWords,
} from "./transcript";

// countTranscriptWords tests
test("countTranscriptWords returns 0 for empty string", () => {
  expect(countTranscriptWords("")).toBe(0);
});

test("countTranscriptWords returns 0 for whitespace-only string", () => {
  expect(countTranscriptWords("   ")).toBe(0);
  expect(countTranscriptWords("\t\n")).toBe(0);
});

test("countTranscriptWords counts single word", () => {
  expect(countTranscriptWords("hello")).toBe(1);
});

test("countTranscriptWords counts multiple words", () => {
  expect(countTranscriptWords("hello world")).toBe(2);
  expect(countTranscriptWords("one two three four five")).toBe(5);
});

test("countTranscriptWords handles multiple spaces between words", () => {
  expect(countTranscriptWords("hello    world")).toBe(2);
});

test("countTranscriptWords handles leading and trailing whitespace", () => {
  expect(countTranscriptWords("  hello world  ")).toBe(2);
});

test("countTranscriptWords handles mixed whitespace", () => {
  expect(countTranscriptWords("hello\tworld\nfoo")).toBe(3);
});

test("countTranscriptWords counts punctuated words", () => {
  expect(countTranscriptWords("Hello, world! How are you?")).toBe(5);
});

test("countTranscriptWords counts typical transcript", () => {
  const text =
    "So today we're going to learn about React hooks and how they work.";
  expect(countTranscriptWords(text)).toBe(13);
});

// transcriptIncludesWord tests
test("transcriptIncludesWord returns false for empty transcript", () => {
  expect(transcriptIncludesWord("", "hello")).toBe(false);
});

test("transcriptIncludesWord returns false for whitespace-only transcript", () => {
  expect(transcriptIncludesWord("   ", "hello")).toBe(false);
});

test("transcriptIncludesWord finds exact word", () => {
  expect(transcriptIncludesWord("hello world", "hello")).toBe(true);
  expect(transcriptIncludesWord("hello world", "world")).toBe(true);
});

test("transcriptIncludesWord returns false for missing word", () => {
  expect(transcriptIncludesWord("hello world", "foo")).toBe(false);
});

test("transcriptIncludesWord is case insensitive", () => {
  expect(transcriptIncludesWord("Hello World", "hello")).toBe(true);
  expect(transcriptIncludesWord("hello world", "HELLO")).toBe(true);
});

test("transcriptIncludesWord does not match partial words", () => {
  expect(transcriptIncludesWord("hello world", "hell")).toBe(false);
  expect(transcriptIncludesWord("hello world", "ello")).toBe(false);
});

test("transcriptIncludesWord handles punctuation", () => {
  expect(transcriptIncludesWord("Hello, world!", "hello")).toBe(true);
  expect(transcriptIncludesWord("Hello, world!", "world")).toBe(true);
});

test("transcriptIncludesWord finds jarvis after jervis normalization", () => {
  expect(transcriptIncludesWord("Jervis said hello", "jarvis")).toBe(true);
});

test("transcriptIncludesWord finds bad and take after badtake normalization", () => {
  expect(transcriptIncludesWord("That was a badtake", "bad")).toBe(true);
  expect(transcriptIncludesWord("That was a badtake", "take")).toBe(true);
});

// normalizeWords - basic normalization
test("normalizeWords returns empty array for empty string", () => {
  expect(normalizeWords("")).toEqual([]);
});

test("normalizeWords returns empty array for whitespace-only string", () => {
  expect(normalizeWords("   ")).toEqual([]);
  expect(normalizeWords("\t\n")).toEqual([]);
});

test("normalizeWords lowercases all words", () => {
  expect(normalizeWords("Hello World")).toEqual(["hello", "world"]);
  expect(normalizeWords("HELLO WORLD")).toEqual(["hello", "world"]);
});

test("normalizeWords removes punctuation", () => {
  expect(normalizeWords("Hello, world!")).toEqual(["hello", "world"]);
  expect(normalizeWords("What's up?")).toEqual(["what", "s", "up"]);
});

test("normalizeWords handles multiple spaces", () => {
  expect(normalizeWords("hello    world")).toEqual(["hello", "world"]);
});

test("normalizeWords preserves numbers", () => {
  expect(normalizeWords("hello 123 world")).toEqual(["hello", "123", "world"]);
});

test("normalizeWords handles mixed alphanumeric", () => {
  expect(normalizeWords("react18 hooks")).toEqual(["react18", "hooks"]);
});

// normalizeWords - corrections
test("normalizeWords corrects jervis to jarvis", () => {
  expect(normalizeWords("jervis")).toEqual(["jarvis"]);
  expect(normalizeWords("Jervis said hello")).toEqual([
    "jarvis",
    "said",
    "hello",
  ]);
});

test("normalizeWords splits badtake into bad take", () => {
  expect(normalizeWords("badtake")).toEqual(["bad", "take"]);
  expect(normalizeWords("That was a badtake")).toEqual([
    "that",
    "was",
    "a",
    "bad",
    "take",
  ]);
});

test("normalizeWords splits batteik into bad take", () => {
  expect(normalizeWords("batteik")).toEqual(["bad", "take"]);
});

test("normalizeWords splits batteke into bad take", () => {
  expect(normalizeWords("batteke")).toEqual(["bad", "take"]);
});

// normalizeWords - blank audio handling
test("normalizeWords returns empty for blank audio", () => {
  expect(normalizeWords("blank audio")).toEqual([]);
});

test("normalizeWords returns empty for Blank Audio (case insensitive)", () => {
  expect(normalizeWords("Blank Audio")).toEqual([]);
});

test("normalizeWords returns empty for blankaudio", () => {
  expect(normalizeWords("blankaudio")).toEqual([]);
});

test("normalizeWords keeps blank and audio in other contexts", () => {
  expect(normalizeWords("blank space")).toEqual(["blank", "space"]);
  expect(normalizeWords("audio file")).toEqual(["audio", "file"]);
});

// normalizeWords - edge cases
test("normalizeWords returns empty for special characters only", () => {
  expect(normalizeWords("!@#$%")).toEqual([]);
});

test("normalizeWords handles single character", () => {
  expect(normalizeWords("a")).toEqual(["a"]);
});

test("normalizeWords handles single number", () => {
  expect(normalizeWords("5")).toEqual(["5"]);
});

test("normalizeWords handles complex sentence with commands", () => {
  expect(
    normalizeWords("Jarvis, bad take! Let's try again... thanks!"),
  ).toEqual(["jarvis", "bad", "take", "let", "s", "try", "again", "thanks"]);
});

test("normalizeWords handles multiple corrections in one string", () => {
  expect(normalizeWords("jervis badtake")).toEqual(["jarvis", "bad", "take"]);
});
