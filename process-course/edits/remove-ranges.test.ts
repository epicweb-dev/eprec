import { test, expect } from 'bun:test'
import { normalizeRemovalRanges, parseTimeRanges } from './remove-ranges'
import type { TimeRange } from '../types'

function createRange(start: number, end: number): TimeRange {
	return { start, end }
}

function createRanges(...pairs: [number, number][]): TimeRange[] {
	return pairs.map(([start, end]) => createRange(start, end))
}

test('parseTimeRanges parses comma and whitespace ranges', () => {
	const ranges = parseTimeRanges('0-1, 2 - 3 4-5')
	expect(ranges).toEqual(createRanges([0, 1], [2, 3], [4, 5]))
})

test('parseTimeRanges parses hh:mm:ss style timestamps', () => {
	const ranges = parseTimeRanges('1:02-1:04.5')
	expect(ranges).toHaveLength(1)
	expect(ranges[0]?.start).toBeCloseTo(62, 6)
	expect(ranges[0]?.end).toBeCloseTo(64.5, 6)
})

test('parseTimeRanges throws when end is missing', () => {
	expect(() => parseTimeRanges('5-')).toThrow('Start and end required')
})

test('normalizeRemovalRanges clamps and merges ranges', () => {
	const { ranges, warnings } = normalizeRemovalRanges({
		ranges: createRanges([-1, 1], [0.8, 1.2], [4, 10]),
		duration: 5,
	})
	expect(ranges).toEqual(createRanges([0, 1.2], [4, 5]))
	expect(warnings.length).toBeGreaterThan(0)
})
