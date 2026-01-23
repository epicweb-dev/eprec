import { test, expect } from "bun:test";
import {
  parseChapterSelection,
  resolveChapterSelection,
} from "./chapter-selection";
import type { ChapterSelection } from "../types";

// Factory for creating expected selection results
function createSelection(
  base: 0 | 1,
  ...ranges: Array<[number, number | null]>
): ChapterSelection {
  return {
    base,
    ranges: ranges.map(([start, end]) => ({ start, end })),
  };
}

// parseChapterSelection - single values
test("parseChapterSelection parses single string number", () => {
  expect(parseChapterSelection("4")).toEqual(createSelection(1, [4, 4]));
});

test("parseChapterSelection parses numeric input", () => {
  expect(parseChapterSelection(4)).toEqual(createSelection(1, [4, 4]));
});

test("parseChapterSelection parses zero as base-0", () => {
  expect(parseChapterSelection("0")).toEqual(createSelection(0, [0, 0]));
});

test("parseChapterSelection parses zero numeric as base-0", () => {
  expect(parseChapterSelection(0)).toEqual(createSelection(0, [0, 0]));
});

// parseChapterSelection - ranges
test("parseChapterSelection parses simple range", () => {
  expect(parseChapterSelection("4-6")).toEqual(createSelection(1, [4, 6]));
});

test("parseChapterSelection parses range with spaces", () => {
  expect(parseChapterSelection("4 - 6")).toEqual(createSelection(1, [4, 6]));
});

test("parseChapterSelection parses open-ended wildcard range", () => {
  expect(parseChapterSelection("4-*")).toEqual(createSelection(1, [4, null]));
});

test("parseChapterSelection parses range starting at zero as base-0", () => {
  expect(parseChapterSelection("0-5")).toEqual(createSelection(0, [0, 5]));
});

test("parseChapterSelection parses zero-to-zero range", () => {
  expect(parseChapterSelection("0-0")).toEqual(createSelection(0, [0, 0]));
});

// parseChapterSelection - comma-separated
test("parseChapterSelection parses comma-separated values", () => {
  expect(parseChapterSelection("4,6,9")).toEqual(
    createSelection(1, [4, 4], [6, 6], [9, 9]),
  );
});

test("parseChapterSelection parses comma-separated with spaces", () => {
  expect(parseChapterSelection("4, 6, 9")).toEqual(
    createSelection(1, [4, 4], [6, 6], [9, 9]),
  );
});

test("parseChapterSelection parses mixed values and ranges", () => {
  expect(parseChapterSelection("4,6,9-12")).toEqual(
    createSelection(1, [4, 4], [6, 6], [9, 12]),
  );
});

test("parseChapterSelection parses complex selection with wildcard", () => {
  expect(parseChapterSelection("1,3-5,8-*")).toEqual(
    createSelection(1, [1, 1], [3, 5], [8, null]),
  );
});

// parseChapterSelection - array input
test("parseChapterSelection parses array of numbers", () => {
  expect(parseChapterSelection([4, 6, 9])).toEqual(
    createSelection(1, [4, 4], [6, 6], [9, 9]),
  );
});

test("parseChapterSelection parses array of strings", () => {
  expect(parseChapterSelection(["4", "6-8"])).toEqual(
    createSelection(1, [4, 4], [6, 8]),
  );
});

test("parseChapterSelection parses mixed array", () => {
  expect(parseChapterSelection([4, "6-8", 10])).toEqual(
    createSelection(1, [4, 4], [6, 8], [10, 10]),
  );
});

test("parseChapterSelection skips null and undefined in array", () => {
  expect(parseChapterSelection([4, null, 6, undefined, 8])).toEqual(
    createSelection(1, [4, 4], [6, 6], [8, 8]),
  );
});

test("parseChapterSelection skips empty strings in array", () => {
  expect(parseChapterSelection(["4", "", "6"])).toEqual(
    createSelection(1, [4, 4], [6, 6]),
  );
});

// parseChapterSelection - edge cases
test("parseChapterSelection trims whitespace", () => {
  expect(parseChapterSelection("  4  ")).toEqual(createSelection(1, [4, 4]));
});

test("parseChapterSelection handles mixed zero and non-zero as base-0", () => {
  expect(parseChapterSelection("0,5")).toEqual(
    createSelection(0, [0, 0], [5, 5]),
  );
});

// parseChapterSelection - error cases
test("parseChapterSelection throws for empty string", () => {
  expect(() => parseChapterSelection("")).toThrow(
    "chapter must include at least one value",
  );
});

test("parseChapterSelection throws for whitespace-only", () => {
  expect(() => parseChapterSelection("   ")).toThrow(
    "chapter must include at least one value",
  );
});

test("parseChapterSelection throws for empty array", () => {
  expect(() => parseChapterSelection([])).toThrow(
    "chapter must include at least one value",
  );
});

test("parseChapterSelection throws for array of nulls", () => {
  expect(() => parseChapterSelection([null, null])).toThrow(
    "chapter must include at least one value",
  );
});

test("parseChapterSelection throws for invalid string", () => {
  expect(() => parseChapterSelection("abc")).toThrow(
    'Invalid chapter value: "abc"',
  );
});

test("parseChapterSelection throws for negative value", () => {
  expect(() => parseChapterSelection("-5")).toThrow(
    'Invalid chapter value: "-5"',
  );
});

test("parseChapterSelection throws for reversed range", () => {
  expect(() => parseChapterSelection("10-5")).toThrow(
    'chapter ranges must be low-to-high: "10-5"',
  );
});

test("parseChapterSelection throws for object input", () => {
  expect(() => parseChapterSelection({ value: 5 })).toThrow(
    "chapter must be a number or range",
  );
});

test("parseChapterSelection throws for boolean input", () => {
  expect(() => parseChapterSelection(true)).toThrow(
    "chapter must be a number or range",
  );
});

// resolveChapterSelection - 1-based
test("resolveChapterSelection resolves single 1-based chapter to index", () => {
  const selection = parseChapterSelection("4");
  expect(resolveChapterSelection(selection, 10)).toEqual([3]);
});

test("resolveChapterSelection resolves 1-based range to indexes", () => {
  const selection = parseChapterSelection("4-6");
  expect(resolveChapterSelection(selection, 10)).toEqual([3, 4, 5]);
});

test("resolveChapterSelection resolves open-ended range to end", () => {
  const selection = parseChapterSelection("8-*");
  expect(resolveChapterSelection(selection, 10)).toEqual([7, 8, 9]);
});

test("resolveChapterSelection resolves comma-separated to indexes", () => {
  const selection = parseChapterSelection("2,5,8");
  expect(resolveChapterSelection(selection, 10)).toEqual([1, 4, 7]);
});

test("resolveChapterSelection resolves complex selection", () => {
  const selection = parseChapterSelection("1,3-5,9");
  expect(resolveChapterSelection(selection, 10)).toEqual([0, 2, 3, 4, 8]);
});

test("resolveChapterSelection deduplicates overlapping ranges", () => {
  const selection = parseChapterSelection("3-5,4-6");
  expect(resolveChapterSelection(selection, 10)).toEqual([2, 3, 4, 5]);
});

test("resolveChapterSelection sorts results", () => {
  const selection = parseChapterSelection("8,2,5");
  expect(resolveChapterSelection(selection, 10)).toEqual([1, 4, 7]);
});

// resolveChapterSelection - 0-based
test("resolveChapterSelection resolves 0-based single chapter", () => {
  const selection = parseChapterSelection("0");
  expect(resolveChapterSelection(selection, 10)).toEqual([0]);
});

test("resolveChapterSelection resolves 0-based range", () => {
  const selection = parseChapterSelection("0-3");
  expect(resolveChapterSelection(selection, 10)).toEqual([0, 1, 2, 3]);
});

test("resolveChapterSelection resolves 0-based open-ended range", () => {
  const selection = parseChapterSelection("0-*");
  expect(resolveChapterSelection(selection, 10)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
});

test("resolveChapterSelection resolves 0-based mixed values", () => {
  const selection = parseChapterSelection("0,5,9");
  expect(resolveChapterSelection(selection, 10)).toEqual([0, 5, 9]);
});

// resolveChapterSelection - boundary cases
test("resolveChapterSelection resolves first chapter (1-based)", () => {
  const selection = parseChapterSelection("1");
  expect(resolveChapterSelection(selection, 5)).toEqual([0]);
});

test("resolveChapterSelection resolves last chapter (1-based)", () => {
  const selection = parseChapterSelection("5");
  expect(resolveChapterSelection(selection, 5)).toEqual([4]);
});

test("resolveChapterSelection resolves all chapters with 1-*", () => {
  const selection = parseChapterSelection("1-*");
  expect(resolveChapterSelection(selection, 5)).toEqual([0, 1, 2, 3, 4]);
});

test("resolveChapterSelection handles single chapter count", () => {
  const selection = parseChapterSelection("1");
  expect(resolveChapterSelection(selection, 1)).toEqual([0]);
});

// resolveChapterSelection - error cases
test("resolveChapterSelection throws for zero chapter count", () => {
  const selection = parseChapterSelection("1");
  expect(() => resolveChapterSelection(selection, 0)).toThrow(
    "Chapter count must be a positive number",
  );
});

test("resolveChapterSelection throws for negative chapter count", () => {
  const selection = parseChapterSelection("1");
  expect(() => resolveChapterSelection(selection, -5)).toThrow(
    "Chapter count must be a positive number",
  );
});

test("resolveChapterSelection throws for NaN chapter count", () => {
  const selection = parseChapterSelection("1");
  expect(() => resolveChapterSelection(selection, NaN)).toThrow(
    "Chapter count must be a positive number",
  );
});

test("resolveChapterSelection throws for chapter beyond count", () => {
  const selection = parseChapterSelection("15");
  expect(() => resolveChapterSelection(selection, 10)).toThrow(
    "chapter range starts at 15, but only 10 chapters exist",
  );
});

test("resolveChapterSelection throws for range starting beyond count", () => {
  const selection = parseChapterSelection("12-15");
  expect(() => resolveChapterSelection(selection, 10)).toThrow(
    "chapter range starts at 12, but only 10 chapters exist",
  );
});

test("resolveChapterSelection throws for range ending beyond count", () => {
  const selection = parseChapterSelection("8-15");
  expect(() => resolveChapterSelection(selection, 10)).toThrow(
    "chapter range ends at 15, but only 10 chapters exist",
  );
});

test("resolveChapterSelection throws for 0-based chapter beyond count", () => {
  const selection = parseChapterSelection("0,10");
  expect(() => resolveChapterSelection(selection, 10)).toThrow(
    "chapter range starts at 10, but only 10 chapters exist",
  );
});
