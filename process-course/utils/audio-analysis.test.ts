import { test, expect } from 'bun:test'
import {
	buildSilenceGapsFromSpeech,
	computeMinWindowRms,
	computeRms,
	findLowestAmplitudeBoundaryProgressive,
	findLowestAmplitudeOffset,
	findSilenceBoundaryFromGaps,
	findSilenceBoundaryProgressive,
	findSilenceBoundaryWithRms,
	findSpeechEndWithRms,
	findSpeechStartWithRms,
	speechFallback,
} from './audio-analysis'
import type { TimeRange } from '../types'

// Factory function for creating audio samples
function createSamples(...values: number[]): Float32Array {
	return new Float32Array(values)
}

function createUniformSamples(value: number, length: number): Float32Array {
	return new Float32Array(length).fill(value)
}

function createRange(start: number, end: number): TimeRange {
	return { start, end }
}

function createRanges(...pairs: [number, number][]): TimeRange[] {
	return pairs.map(([start, end]) => createRange(start, end))
}

function createRmsOptions(
	samples: number[],
	direction: 'before' | 'after',
	overrides: Partial<{
		sampleRate: number
		rmsWindowMs: number
		rmsThreshold: number
		minSilenceMs: number
	}> = {},
) {
	return {
		samples: createSamples(...samples),
		sampleRate: overrides.sampleRate ?? 10,
		direction,
		rmsWindowMs: overrides.rmsWindowMs ?? 100,
		rmsThreshold: overrides.rmsThreshold ?? 0.5,
		minSilenceMs: overrides.minSilenceMs ?? 200,
	}
}

function createProgressiveOptions(
	samples: number[],
	direction: 'before' | 'after',
	overrides: Partial<{
		sampleRate: number
		startWindowSeconds: number
		stepSeconds: number
		maxWindowSeconds: number
		rmsWindowMs: number
		rmsThreshold: number
		minSilenceMs: number
	}> = {},
) {
	const sampleRate = overrides.sampleRate ?? 10
	const maxWindowSeconds =
		overrides.maxWindowSeconds ?? samples.length / sampleRate
	return {
		samples: createSamples(...samples),
		sampleRate,
		direction,
		startWindowSeconds: overrides.startWindowSeconds ?? 0.2,
		stepSeconds: overrides.stepSeconds ?? 0.2,
		maxWindowSeconds,
		rmsWindowMs: overrides.rmsWindowMs ?? 100,
		rmsThreshold: overrides.rmsThreshold ?? 0.5,
		minSilenceMs: overrides.minSilenceMs ?? 100,
	}
}

// computeRms tests
test('computeRms returns 0 for empty array', () => {
	expect(computeRms(createSamples())).toBe(0)
})

test('computeRms returns 0 for all zeros', () => {
	expect(computeRms(createSamples(0, 0, 0, 0))).toBe(0)
})

test('computeRms computes correct value for uniform samples', () => {
	expect(computeRms(createSamples(1, 1, 1, 1))).toBe(1)
})

test('computeRms computes correct value for [3, 4]', () => {
	const samples = createSamples(3, 4)
	expect(computeRms(samples)).toBeCloseTo(Math.sqrt(12.5))
})

test('computeRms handles negative values correctly', () => {
	expect(computeRms(createSamples(-1, -1, -1, -1))).toBe(1)
})

test('computeRms handles mixed positive and negative values', () => {
	expect(computeRms(createSamples(1, -1, 1, -1))).toBe(1)
})

test('computeRms computes correct value for single sample', () => {
	expect(computeRms(createSamples(5))).toBe(5)
})

test('computeRms computes correct value for typical audio samples', () => {
	const samples = createSamples(0.5, -0.3, 0.8, -0.2, 0.1)
	const expectedSumSquares = 0.25 + 0.09 + 0.64 + 0.04 + 0.01
	const expectedRms = Math.sqrt(expectedSumSquares / 5)
	expect(computeRms(samples)).toBeCloseTo(expectedRms)
})

test('computeRms handles very small values', () => {
	const samples = createSamples(0.001, 0.002, 0.001, 0.002)
	const rms = computeRms(samples)
	expect(rms).toBeGreaterThan(0)
	expect(rms).toBeLessThan(0.01)
})

// computeMinWindowRms tests
test('computeMinWindowRms returns 0 for empty array', () => {
	expect(computeMinWindowRms(createSamples(), 10)).toBe(0)
})

test('computeMinWindowRms returns 0 for zero window size', () => {
	expect(computeMinWindowRms(createSamples(1, 2, 3), 0)).toBe(0)
})

test('computeMinWindowRms returns 0 for negative window size', () => {
	expect(computeMinWindowRms(createSamples(1, 2, 3), -5)).toBe(0)
})

test('computeMinWindowRms returns full RMS when window exceeds samples', () => {
	const samples = createSamples(1, 2, 3)
	expect(computeMinWindowRms(samples, 5)).toBe(computeRms(samples))
})

test('computeMinWindowRms returns full RMS when window equals samples', () => {
	const samples = createSamples(1, 2, 3)
	expect(computeMinWindowRms(samples, 3)).toBe(computeRms(samples))
})

test('computeMinWindowRms finds quietest section', () => {
	// Loud (RMS=1) | Quiet (RMS=0.1) | Loud (RMS=1)
	const samples = createSamples(1, 1, 1, 1, 0.1, 0.1, 1, 1, 1, 1)
	expect(computeMinWindowRms(samples, 2)).toBeCloseTo(0.1)
})

test('computeMinWindowRms with window size 1 finds minimum absolute value', () => {
	const samples = createSamples(5, 1, 3, 0, 4)
	expect(computeMinWindowRms(samples, 1)).toBe(0)
})

test('computeMinWindowRms returns same value for uniform array', () => {
	const samples = createUniformSamples(0.5, 5)
	expect(computeMinWindowRms(samples, 2)).toBeCloseTo(0.5)
})

test('computeMinWindowRms finds minimum at start', () => {
	const samples = createSamples(0.1, 0.1, 1, 1, 1, 1)
	expect(computeMinWindowRms(samples, 2)).toBeCloseTo(0.1)
})

test('computeMinWindowRms finds minimum at end', () => {
	const samples = createSamples(1, 1, 1, 1, 0.1, 0.1)
	expect(computeMinWindowRms(samples, 2)).toBeCloseTo(0.1)
})

test('computeMinWindowRms returns 0 for silence', () => {
	const samples = createUniformSamples(0, 6)
	expect(computeMinWindowRms(samples, 3)).toBe(0)
})

test('computeMinWindowRms handles mixed positive and negative', () => {
	const samples = createSamples(1, -1, 1, -1, 0.1, -0.1, 1, -1, 1, -1)
	expect(computeMinWindowRms(samples, 2)).toBeCloseTo(0.1)
})

test('findSpeechStartWithRms finds first non-silent window', () => {
	const start = findSpeechStartWithRms({
		samples: createSamples(0, 0, 0, 1, 1),
		sampleRate: 10,
		rmsWindowMs: 100,
		rmsThreshold: 0.5,
	})
	expect(start).toBeCloseTo(0.3, 3)
})

test('findSpeechStartWithRms returns null for silence', () => {
	const start = findSpeechStartWithRms({
		samples: createSamples(0, 0, 0, 0),
		sampleRate: 10,
		rmsWindowMs: 100,
		rmsThreshold: 0.1,
	})
	expect(start).toBeNull()
})

test('findSpeechEndWithRms finds last non-silent window', () => {
	const end = findSpeechEndWithRms({
		samples: createSamples(1, 1, 0, 0),
		sampleRate: 10,
		rmsWindowMs: 100,
		rmsThreshold: 0.5,
	})
	expect(end).toBeCloseTo(0.2, 3)
})

test('findSpeechEndWithRms returns null for silence', () => {
	const end = findSpeechEndWithRms({
		samples: createSamples(0, 0, 0, 0),
		sampleRate: 10,
		rmsWindowMs: 100,
		rmsThreshold: 0.1,
	})
	expect(end).toBeNull()
})

// buildSilenceGapsFromSpeech tests
test('buildSilenceGapsFromSpeech returns full gap for no speech', () => {
	expect(buildSilenceGapsFromSpeech([], 10)).toEqual([createRange(0, 10)])
})

test('buildSilenceGapsFromSpeech returns gaps between segments', () => {
	const segments = createRanges([0, 1], [3, 4])
	expect(buildSilenceGapsFromSpeech(segments, 5)).toEqual(
		createRanges([1, 3], [4, 5]),
	)
})

test('buildSilenceGapsFromSpeech filters tiny gaps', () => {
	const segments = createRanges([0, 1], [1.0005, 2])
	expect(buildSilenceGapsFromSpeech(segments, 2)).toEqual([])
})

// findSilenceBoundaryFromGaps tests
test('findSilenceBoundaryFromGaps returns target inside gap', () => {
	const gaps = createRanges([0, 2], [4, 6])
	expect(findSilenceBoundaryFromGaps(gaps, 1.5, 'before')).toBe(1.5)
})

test('findSilenceBoundaryFromGaps finds boundary before target', () => {
	const gaps = createRanges([0, 1], [3, 4])
	expect(findSilenceBoundaryFromGaps(gaps, 2, 'before')).toBe(1)
})

test('findSilenceBoundaryFromGaps finds boundary after target', () => {
	const gaps = createRanges([0, 1], [3, 4])
	expect(findSilenceBoundaryFromGaps(gaps, 2, 'after')).toBe(3)
})

test('findSilenceBoundaryFromGaps returns null when none found', () => {
	const gaps = createRanges([1, 2])
	expect(findSilenceBoundaryFromGaps(gaps, 0.5, 'before')).toBeNull()
})

// speechFallback tests
test('speechFallback returns full duration range with note', () => {
	expect(speechFallback(12.5, 'fallback')).toEqual({
		start: 0,
		end: 12.5,
		note: 'fallback',
	})
})

// findSilenceBoundaryWithRms tests
test('findSilenceBoundaryWithRms returns null for empty samples', () => {
	const options = createRmsOptions([], 'after')
	expect(findSilenceBoundaryWithRms(options)).toBeNull()
})

test('findSilenceBoundaryWithRms finds silence start for after direction', () => {
	const options = createRmsOptions([1, 1, 0, 0, 1], 'after')
	expect(findSilenceBoundaryWithRms(options)).toBeCloseTo(0.2)
})

test('findSilenceBoundaryWithRms finds silence end for before direction', () => {
	const options = createRmsOptions([1, 1, 1, 0, 0], 'before')
	expect(findSilenceBoundaryWithRms(options)).toBeCloseTo(0.5)
})

test('findSilenceBoundaryWithRms returns null when silence is too short', () => {
	const options = createRmsOptions([1, 0, 1, 1], 'after')
	expect(findSilenceBoundaryWithRms(options)).toBeNull()
})

test('findLowestAmplitudeOffset picks the lowest RMS window', () => {
	const result = findLowestAmplitudeOffset({
		samples: createSamples(1, 1, 1, 0, 0, 0),
		sampleRate: 10,
		rmsWindowMs: 100,
	})
	expect(result).not.toBeNull()
	expect(result?.offsetSeconds).toBeCloseTo(0.35, 3)
	expect(result?.rms).toBeLessThan(0.2)
})

test('findLowestAmplitudeBoundaryProgressive uses closest low amplitude', () => {
	const options = createProgressiveOptions(
		[1, 1, 1, 1, 0, 0, 0, 1, 1, 1],
		'before',
		{ startWindowSeconds: 0.2, stepSeconds: 0.2, maxWindowSeconds: 1 },
	)
	const boundary = findLowestAmplitudeBoundaryProgressive({
		...options,
		rmsThreshold: 0.2,
	})
	expect(boundary).toBeCloseTo(0.65, 2)
})

test('findLowestAmplitudeBoundaryProgressive returns null without quiet audio', () => {
	const options = createProgressiveOptions([1, 1, 1, 1, 1], 'after', {
		startWindowSeconds: 0.2,
		stepSeconds: 0.2,
		maxWindowSeconds: 0.5,
	})
	const boundary = findLowestAmplitudeBoundaryProgressive({
		...options,
		rmsThreshold: 0.2,
	})
	expect(boundary).toBeNull()
})

test('findSilenceBoundaryProgressive widens window until silence is found', () => {
	const options = createProgressiveOptions(
		[1, 1, 1, 1, 1, 0, 0, 1, 1, 1],
		'before',
		{ startWindowSeconds: 0.2, stepSeconds: 0.2, maxWindowSeconds: 1 },
	)
	const boundary = findSilenceBoundaryProgressive(options)
	expect(boundary).toBeCloseTo(0.7, 3)
})

test('findSilenceBoundaryProgressive returns null when no silence exists', () => {
	const options = createProgressiveOptions([1, 1, 1, 1, 1], 'after', {
		startWindowSeconds: 0.2,
		stepSeconds: 0.2,
		maxWindowSeconds: 0.5,
	})
	expect(findSilenceBoundaryProgressive(options)).toBeNull()
})
