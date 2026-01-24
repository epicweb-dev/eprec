import type { ChapterRange, ChapterSelection } from '../types'

/**
 * Parse a chapter selection string (e.g., "4", "4-6", "4,6,9-12", "4-*").
 */
export function parseChapterSelection(rawSelection: unknown): ChapterSelection {
	const rawList = Array.isArray(rawSelection) ? rawSelection : [rawSelection]
	const parts: string[] = []

	for (const value of rawList) {
		if (value === undefined || value === null) {
			continue
		}
		if (typeof value === 'number') {
			parts.push(String(value))
			continue
		}
		if (typeof value === 'string') {
			const chunk = value.trim()
			if (chunk.length === 0) {
				continue
			}
			parts.push(
				...chunk
					.split(',')
					.map((item) => item.trim())
					.filter(Boolean),
			)
			continue
		}
		throw new Error('chapter must be a number or range (e.g. 4, 4-6, 4-*)')
	}

	if (parts.length === 0) {
		throw new Error('chapter must include at least one value.')
	}

	const ranges: ChapterRange[] = []
	let hasZero = false

	for (const part of parts) {
		const rangeMatch = part.match(/^(\d+)\s*-\s*(\*|\d+)$/)
		if (rangeMatch) {
			const startToken = rangeMatch[1]
			const endToken = rangeMatch[2]
			if (!startToken || !endToken) {
				throw new Error(`Invalid chapter range: "${part}".`)
			}
			const start = Number.parseInt(startToken, 10)
			const end = endToken === '*' ? null : Number.parseInt(endToken, 10)

			if (!Number.isFinite(start)) {
				throw new Error(`Invalid chapter range start: "${part}".`)
			}
			if (end !== null && !Number.isFinite(end)) {
				throw new Error(`Invalid chapter range end: "${part}".`)
			}
			if (start < 0 || (end !== null && end < 0)) {
				throw new Error(`chapter values must be >= 0: "${part}".`)
			}
			if (end !== null && end < start) {
				throw new Error(`chapter ranges must be low-to-high: "${part}".`)
			}

			if (start === 0 || end === 0) {
				hasZero = true
			}
			ranges.push({ start, end })
			continue
		}

		const singleMatch = part.match(/^\d+$/)
		if (singleMatch) {
			const value = Number.parseInt(part, 10)
			if (!Number.isFinite(value)) {
				throw new Error(`Invalid chapter value: "${part}".`)
			}
			if (value < 0) {
				throw new Error(`chapter values must be >= 0: "${part}".`)
			}
			if (value === 0) {
				hasZero = true
			}
			ranges.push({ start: value, end: value })
			continue
		}

		throw new Error(`Invalid chapter value: "${part}".`)
	}

	return { base: hasZero ? 0 : 1, ranges }
}

/**
 * Resolve a chapter selection to an array of zero-based chapter indexes.
 */
export function resolveChapterSelection(
	selection: ChapterSelection,
	chapterCount: number,
): number[] {
	if (!Number.isFinite(chapterCount) || chapterCount <= 0) {
		throw new Error('Chapter count must be a positive number.')
	}

	const maxIndex = chapterCount - 1
	const maxValue = selection.base === 0 ? maxIndex : chapterCount
	const indexes: number[] = []

	for (const range of selection.ranges) {
		const startValue = range.start
		const endValue = range.end === null ? maxValue : range.end

		if (startValue > maxValue) {
			throw new Error(
				`chapter range starts at ${startValue}, but only ${chapterCount} chapters exist.`,
			)
		}
		if (endValue > maxValue) {
			throw new Error(
				`chapter range ends at ${endValue}, but only ${chapterCount} chapters exist.`,
			)
		}

		for (let value = startValue; value <= endValue; value += 1) {
			const index = selection.base === 0 ? value : value - 1
			if (index < 0 || index > maxIndex) {
				throw new Error(
					`chapter selection ${value} is out of range for ${chapterCount} chapters.`,
				)
			}
			indexes.push(index)
		}
	}

	return Array.from(new Set(indexes)).sort((a, b) => a - b)
}
