import { test, expect } from "bun:test";
import {
  mergeTimeRanges,
  buildKeepRanges,
  sumRangeDuration,
  adjustTimeForRemovedRanges,
} from "./time-ranges";
import type { TimeRange } from "../types";

// Factory functions for test data
function createRange(start: number, end: number): TimeRange {
  return { start, end };
}

function createRanges(...pairs: [number, number][]): TimeRange[] {
  return pairs.map(([start, end]) => createRange(start, end));
}

// mergeTimeRanges tests
test("mergeTimeRanges returns empty array for empty input", () => {
  expect(mergeTimeRanges([])).toEqual([]);
});

test("mergeTimeRanges returns single range unchanged", () => {
  expect(mergeTimeRanges([createRange(1, 5)])).toEqual([createRange(1, 5)]);
});

test("mergeTimeRanges merges overlapping ranges", () => {
  const ranges = createRanges([1, 5], [3, 8]);
  expect(mergeTimeRanges(ranges)).toEqual([createRange(1, 8)]);
});

test("mergeTimeRanges merges adjacent ranges within 0.01 tolerance", () => {
  const ranges = createRanges([1, 5], [5.005, 8]);
  expect(mergeTimeRanges(ranges)).toEqual([createRange(1, 8)]);
});

test("mergeTimeRanges keeps separate non-adjacent ranges", () => {
  const ranges = createRanges([1, 5], [6, 10]);
  expect(mergeTimeRanges(ranges)).toEqual(createRanges([1, 5], [6, 10]));
});

test("mergeTimeRanges handles unsorted input", () => {
  const ranges = createRanges([10, 15], [1, 5], [3, 8]);
  expect(mergeTimeRanges(ranges)).toEqual(createRanges([1, 8], [10, 15]));
});

test("mergeTimeRanges merges multiple overlapping ranges into one", () => {
  const ranges = createRanges([1, 3], [2, 5], [4, 7], [6, 10]);
  expect(mergeTimeRanges(ranges)).toEqual([createRange(1, 10)]);
});

test("mergeTimeRanges handles contained range", () => {
  const ranges = createRanges([1, 10], [3, 5]);
  expect(mergeTimeRanges(ranges)).toEqual([createRange(1, 10)]);
});

test("mergeTimeRanges handles same start time", () => {
  const ranges = createRanges([1, 5], [1, 8]);
  expect(mergeTimeRanges(ranges)).toEqual([createRange(1, 8)]);
});

test("mergeTimeRanges handles same end time", () => {
  const ranges = createRanges([1, 10], [5, 10]);
  expect(mergeTimeRanges(ranges)).toEqual([createRange(1, 10)]);
});

test("mergeTimeRanges handles zero-width range", () => {
  expect(mergeTimeRanges([createRange(5, 5)])).toEqual([createRange(5, 5)]);
});

// buildKeepRanges tests
test("buildKeepRanges returns full range when no exclusions", () => {
  expect(buildKeepRanges(0, 100, [])).toEqual([createRange(0, 100)]);
});

test("buildKeepRanges excludes single middle range", () => {
  const exclude = [createRange(30, 50)];
  expect(buildKeepRanges(0, 100, exclude)).toEqual(
    createRanges([0, 30], [50, 100]),
  );
});

test("buildKeepRanges excludes range at start", () => {
  const exclude = [createRange(0, 20)];
  expect(buildKeepRanges(0, 100, exclude)).toEqual([createRange(20, 100)]);
});

test("buildKeepRanges excludes range at end", () => {
  const exclude = [createRange(80, 100)];
  expect(buildKeepRanges(0, 100, exclude)).toEqual([createRange(0, 80)]);
});

test("buildKeepRanges excludes multiple non-overlapping ranges", () => {
  const exclude = createRanges([10, 20], [50, 60]);
  expect(buildKeepRanges(0, 100, exclude)).toEqual(
    createRanges([0, 10], [20, 50], [60, 100]),
  );
});

test("buildKeepRanges merges overlapping exclusions", () => {
  const exclude = createRanges([10, 30], [20, 40]);
  expect(buildKeepRanges(0, 100, exclude)).toEqual(
    createRanges([0, 10], [40, 100]),
  );
});

test("buildKeepRanges handles exclusion beyond end", () => {
  const exclude = [createRange(80, 120)];
  expect(buildKeepRanges(0, 100, exclude)).toEqual([createRange(0, 80)]);
});

test("buildKeepRanges handles exclusion before start", () => {
  const exclude = [createRange(-10, 20)];
  expect(buildKeepRanges(0, 100, exclude)).toEqual([createRange(20, 100)]);
});

test("buildKeepRanges returns empty when entire range excluded", () => {
  const exclude = [createRange(0, 100)];
  expect(buildKeepRanges(0, 100, exclude)).toEqual([]);
});

test("buildKeepRanges handles unsorted exclusions", () => {
  const exclude = createRanges([50, 60], [10, 20]);
  expect(buildKeepRanges(0, 100, exclude)).toEqual(
    createRanges([0, 10], [20, 50], [60, 100]),
  );
});

test("buildKeepRanges filters zero-width keep ranges", () => {
  const exclude = createRanges([0, 50], [50, 100]);
  expect(buildKeepRanges(0, 100, exclude)).toEqual([]);
});

test("buildKeepRanges ignores exclusion before range", () => {
  const exclude = [createRange(-20, -10)];
  expect(buildKeepRanges(0, 100, exclude)).toEqual([createRange(0, 100)]);
});

// sumRangeDuration tests
test("sumRangeDuration returns 0 for empty array", () => {
  expect(sumRangeDuration([])).toBe(0);
});

test("sumRangeDuration returns duration of single range", () => {
  expect(sumRangeDuration([createRange(10, 30)])).toBe(20);
});

test("sumRangeDuration sums multiple ranges", () => {
  const ranges = createRanges([0, 10], [20, 35], [50, 60]);
  expect(sumRangeDuration(ranges)).toBe(35);
});

test("sumRangeDuration handles zero-width ranges", () => {
  const ranges = createRanges([5, 5], [10, 20]);
  expect(sumRangeDuration(ranges)).toBe(10);
});

test("sumRangeDuration handles invalid negative duration", () => {
  expect(sumRangeDuration([createRange(20, 10)])).toBe(-10);
});

test("sumRangeDuration handles floating point values", () => {
  const ranges = createRanges([0, 1.5], [2.5, 4.75]);
  expect(sumRangeDuration(ranges)).toBeCloseTo(3.75);
});

// adjustTimeForRemovedRanges tests
test("adjustTimeForRemovedRanges returns same time when no ranges removed", () => {
  expect(adjustTimeForRemovedRanges(50, [])).toBe(50);
});

test("adjustTimeForRemovedRanges adjusts for removed range before time", () => {
  const removed = [createRange(10, 20)];
  expect(adjustTimeForRemovedRanges(50, removed)).toBe(40);
});

test("adjustTimeForRemovedRanges does not adjust for removed range after time", () => {
  const removed = [createRange(60, 80)];
  expect(adjustTimeForRemovedRanges(50, removed)).toBe(50);
});

test("adjustTimeForRemovedRanges adjusts for multiple removed ranges", () => {
  const removed = createRanges([5, 10], [20, 30]);
  expect(adjustTimeForRemovedRanges(50, removed)).toBe(35);
});

test("adjustTimeForRemovedRanges handles time within removed range", () => {
  const removed = [createRange(40, 60)];
  expect(adjustTimeForRemovedRanges(50, removed)).toBe(40);
});

test("adjustTimeForRemovedRanges handles time at start of removed range", () => {
  const removed = [createRange(50, 60)];
  expect(adjustTimeForRemovedRanges(50, removed)).toBe(50);
});

test("adjustTimeForRemovedRanges handles time at end of removed range", () => {
  const removed = [createRange(40, 50)];
  expect(adjustTimeForRemovedRanges(50, removed)).toBe(40);
});

test("adjustTimeForRemovedRanges handles overlapping removed ranges", () => {
  const removed = createRanges([10, 30], [20, 40]);
  expect(adjustTimeForRemovedRanges(50, removed)).toBe(20);
});

test("adjustTimeForRemovedRanges handles unsorted removed ranges", () => {
  const removed = createRanges([30, 40], [10, 20]);
  expect(adjustTimeForRemovedRanges(50, removed)).toBe(30);
});

test("adjustTimeForRemovedRanges handles time at zero", () => {
  const removed = [createRange(10, 20)];
  expect(adjustTimeForRemovedRanges(0, removed)).toBe(0);
});

test("adjustTimeForRemovedRanges handles removed range starting at zero", () => {
  const removed = [createRange(0, 10)];
  expect(adjustTimeForRemovedRanges(50, removed)).toBe(40);
});
