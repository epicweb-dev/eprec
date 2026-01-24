import { test, expect } from "bun:test";
import { wordsToTimeRanges } from "./timestamp-refinement";
import type { TranscriptWordWithIndex } from "./types";

function createWord(
  word: string,
  start: number,
  end: number,
  index = 0,
): TranscriptWordWithIndex {
  return { word, start, end, index };
}

test("wordsToTimeRanges merges overlapping ranges", () => {
  const words = [
    createWord("hello", 0, 0.5, 0),
    createWord("world", 0.45, 1, 1),
  ];
  const ranges = wordsToTimeRanges(words);
  expect(ranges).toEqual([{ start: 0, end: 1 }]);
});

test("wordsToTimeRanges returns empty for no words", () => {
  expect(wordsToTimeRanges([])).toEqual([]);
});
