import { test, expect } from "bun:test";
import { computeRms, computeMinWindowRms } from "./audio-analysis";

// Factory function for creating audio samples
function createSamples(...values: number[]): Float32Array {
  return new Float32Array(values);
}

function createUniformSamples(value: number, length: number): Float32Array {
  return new Float32Array(length).fill(value);
}

// computeRms tests
test("computeRms returns 0 for empty array", () => {
  expect(computeRms(createSamples())).toBe(0);
});

test("computeRms returns 0 for all zeros", () => {
  expect(computeRms(createSamples(0, 0, 0, 0))).toBe(0);
});

test("computeRms computes correct value for uniform samples", () => {
  expect(computeRms(createSamples(1, 1, 1, 1))).toBe(1);
});

test("computeRms computes correct value for [3, 4]", () => {
  const samples = createSamples(3, 4);
  expect(computeRms(samples)).toBeCloseTo(Math.sqrt(12.5));
});

test("computeRms handles negative values correctly", () => {
  expect(computeRms(createSamples(-1, -1, -1, -1))).toBe(1);
});

test("computeRms handles mixed positive and negative values", () => {
  expect(computeRms(createSamples(1, -1, 1, -1))).toBe(1);
});

test("computeRms computes correct value for single sample", () => {
  expect(computeRms(createSamples(5))).toBe(5);
});

test("computeRms computes correct value for typical audio samples", () => {
  const samples = createSamples(0.5, -0.3, 0.8, -0.2, 0.1);
  const expectedSumSquares = 0.25 + 0.09 + 0.64 + 0.04 + 0.01;
  const expectedRms = Math.sqrt(expectedSumSquares / 5);
  expect(computeRms(samples)).toBeCloseTo(expectedRms);
});

test("computeRms handles very small values", () => {
  const samples = createSamples(0.001, 0.002, 0.001, 0.002);
  const rms = computeRms(samples);
  expect(rms).toBeGreaterThan(0);
  expect(rms).toBeLessThan(0.01);
});

// computeMinWindowRms tests
test("computeMinWindowRms returns 0 for empty array", () => {
  expect(computeMinWindowRms(createSamples(), 10)).toBe(0);
});

test("computeMinWindowRms returns 0 for zero window size", () => {
  expect(computeMinWindowRms(createSamples(1, 2, 3), 0)).toBe(0);
});

test("computeMinWindowRms returns 0 for negative window size", () => {
  expect(computeMinWindowRms(createSamples(1, 2, 3), -5)).toBe(0);
});

test("computeMinWindowRms returns full RMS when window exceeds samples", () => {
  const samples = createSamples(1, 2, 3);
  expect(computeMinWindowRms(samples, 5)).toBe(computeRms(samples));
});

test("computeMinWindowRms returns full RMS when window equals samples", () => {
  const samples = createSamples(1, 2, 3);
  expect(computeMinWindowRms(samples, 3)).toBe(computeRms(samples));
});

test("computeMinWindowRms finds quietest section", () => {
  // Loud (RMS=1) | Quiet (RMS=0.1) | Loud (RMS=1)
  const samples = createSamples(1, 1, 1, 1, 0.1, 0.1, 1, 1, 1, 1);
  expect(computeMinWindowRms(samples, 2)).toBeCloseTo(0.1);
});

test("computeMinWindowRms with window size 1 finds minimum absolute value", () => {
  const samples = createSamples(5, 1, 3, 0, 4);
  expect(computeMinWindowRms(samples, 1)).toBe(0);
});

test("computeMinWindowRms returns same value for uniform array", () => {
  const samples = createUniformSamples(0.5, 5);
  expect(computeMinWindowRms(samples, 2)).toBeCloseTo(0.5);
});

test("computeMinWindowRms finds minimum at start", () => {
  const samples = createSamples(0.1, 0.1, 1, 1, 1, 1);
  expect(computeMinWindowRms(samples, 2)).toBeCloseTo(0.1);
});

test("computeMinWindowRms finds minimum at end", () => {
  const samples = createSamples(1, 1, 1, 1, 0.1, 0.1);
  expect(computeMinWindowRms(samples, 2)).toBeCloseTo(0.1);
});

test("computeMinWindowRms returns 0 for silence", () => {
  const samples = createUniformSamples(0, 6);
  expect(computeMinWindowRms(samples, 3)).toBe(0);
});

test("computeMinWindowRms handles mixed positive and negative", () => {
  const samples = createSamples(1, -1, 1, -1, 0.1, -0.1, 1, -1, 1, -1);
  expect(computeMinWindowRms(samples, 2)).toBeCloseTo(0.1);
});
