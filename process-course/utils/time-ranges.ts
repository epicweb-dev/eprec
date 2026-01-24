import type { TimeRange } from '../types'

/**
 * Merge overlapping or adjacent time ranges into a minimal set of non-overlapping ranges.
 */
export function mergeTimeRanges(ranges: TimeRange[]): TimeRange[] {
	if (ranges.length === 0) {
		return []
	}
	const sorted = [...ranges].sort((a, b) => a.start - b.start)
	const merged: TimeRange[] = []
	let current = sorted[0]
	if (!current) {
		return []
	}
	for (const range of sorted.slice(1)) {
		if (range.start <= current.end + 0.01) {
			current = { start: current.start, end: Math.max(current.end, range.end) }
		} else {
			merged.push(current)
			current = range
		}
	}
	merged.push(current)
	return merged
}

/**
 * Build keep ranges by subtracting exclusion windows from a full duration.
 */
export function buildKeepRanges(
	start: number,
	end: number,
	exclude: TimeRange[],
): TimeRange[] {
	if (exclude.length === 0) {
		return [{ start, end }]
	}
	const ranges: TimeRange[] = []
	let cursor = start
	for (const window of mergeTimeRanges(exclude)) {
		if (window.end <= cursor) {
			continue
		}
		if (window.start > cursor) {
			ranges.push({ start: cursor, end: window.start })
		}
		cursor = Math.max(cursor, window.end)
	}
	if (cursor < end) {
		ranges.push({ start: cursor, end })
	}
	return ranges.filter((range) => range.end > range.start)
}

/**
 * Sum the total duration of a set of time ranges.
 */
export function sumRangeDuration(ranges: TimeRange[]): number {
	return ranges.reduce((total, range) => total + (range.end - range.start), 0)
}

/**
 * Adjust a timestamp to account for removed time ranges.
 */
export function adjustTimeForRemovedRanges(
	time: number,
	removed: TimeRange[],
): number {
	if (removed.length === 0) {
		return time
	}
	let adjusted = time
	for (const range of mergeTimeRanges(removed)) {
		if (range.end <= time) {
			adjusted -= range.end - range.start
			continue
		}
		if (range.start < time && range.end > time) {
			adjusted -= time - range.start
			break
		}
		break
	}
	return adjusted
}
