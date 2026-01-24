#!/usr/bin/env bun
import path from 'node:path'
import os from 'node:os'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import yargs from 'yargs/yargs'
import { hideBin } from 'yargs/helpers'
import { extractChapterSegmentAccurate, concatSegments } from '../ffmpeg'
import { buildKeepRanges, mergeTimeRanges } from '../utils/time-ranges'
import { clamp, getMediaDurationSeconds } from '../../utils'
import type { TimeRange } from '../types'

export type RemoveRangesOptions = {
	inputPath: string
	outputPath: string
	ranges: TimeRange[]
	duration?: number
}

export type RemoveRangesResult = {
	success: boolean
	error?: string
	outputPath?: string
	removedRanges: TimeRange[]
	keepRanges: TimeRange[]
}

export function buildRangesRemovedOutputPath(inputPath: string): string {
	const parsed = path.parse(inputPath)
	return path.join(parsed.dir, `${parsed.name}.ranges-removed${parsed.ext}`)
}

export function parseTimeRanges(value: string): TimeRange[] {
	const trimmed = value.trim()
	if (!trimmed) {
		throw new Error('No time ranges provided.')
	}
	const normalized = trimmed
		.replace(/\s*-\s*/g, '-')
		.replace(/\s*\.\.\s*/g, '..')
	const tokens = normalized.split(/[\s,;]+/).filter(Boolean)
	if (tokens.length === 0) {
		throw new Error('No time ranges provided.')
	}
	return tokens.map(parseRangeToken)
}

export function normalizeRemovalRanges(options: {
	ranges: TimeRange[]
	duration: number
}): { ranges: TimeRange[]; warnings: string[] } {
	const normalized: TimeRange[] = []
	const warnings: string[] = []
	for (const range of options.ranges) {
		const clampedStart = clamp(range.start, 0, options.duration)
		const clampedEnd = clamp(range.end, 0, options.duration)
		if (clampedStart !== range.start || clampedEnd !== range.end) {
			warnings.push(
				`Clamped range ${range.start.toFixed(3)}-${range.end.toFixed(3)} to ${clampedStart.toFixed(3)}-${clampedEnd.toFixed(3)}.`,
			)
		}
		if (clampedEnd <= clampedStart + 0.005) {
			warnings.push(
				`Skipping empty range ${clampedStart.toFixed(3)}-${clampedEnd.toFixed(3)}.`,
			)
			continue
		}
		normalized.push({ start: clampedStart, end: clampedEnd })
	}
	return { ranges: mergeTimeRanges(normalized), warnings }
}

export async function removeRangesFromMedia(
	options: RemoveRangesOptions,
): Promise<RemoveRangesResult> {
	const removedRanges: TimeRange[] = []
	const keepRanges: TimeRange[] = []
	try {
		const duration =
			typeof options.duration === 'number'
				? options.duration
				: await getMediaDurationSeconds(options.inputPath)
		const normalized = normalizeRemovalRanges({
			ranges: options.ranges,
			duration,
		})
		normalized.warnings.forEach((warning) => console.warn(`[warn] ${warning}`))
		removedRanges.push(...normalized.ranges)
		if (removedRanges.length === 0) {
			return {
				success: false,
				error: 'No valid ranges to remove after normalization.',
				removedRanges,
				keepRanges,
			}
		}
		keepRanges.push(...buildKeepRanges(0, duration, removedRanges))
		if (keepRanges.length === 0) {
			return {
				success: false,
				error: 'Requested removals delete the entire file.',
				removedRanges,
				keepRanges,
			}
		}

		const resolvedInput = path.resolve(options.inputPath)
		const resolvedOutput = path.resolve(options.outputPath)
		if (resolvedInput === resolvedOutput) {
			return {
				success: false,
				error: 'Output path must be different from input path.',
				removedRanges,
				keepRanges,
			}
		}

		await mkdir(path.dirname(options.outputPath), { recursive: true })

		const isFullRange =
			keepRanges.length === 1 &&
			keepRanges[0] &&
			keepRanges[0].start <= 0.001 &&
			keepRanges[0].end >= duration - 0.001
		if (isFullRange) {
			await copyFile(options.inputPath, options.outputPath)
			return {
				success: true,
				outputPath: options.outputPath,
				removedRanges,
				keepRanges,
			}
		}

		if (keepRanges.length === 1 && keepRanges[0]) {
			await extractChapterSegmentAccurate({
				inputPath: options.inputPath,
				outputPath: options.outputPath,
				start: keepRanges[0].start,
				end: keepRanges[0].end,
			})
			return {
				success: true,
				outputPath: options.outputPath,
				removedRanges,
				keepRanges,
			}
		}

		const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remove-ranges-'))
		try {
			const segmentPaths: string[] = []
			for (const [index, range] of keepRanges.entries()) {
				const segmentPath = path.join(tempDir, `segment-${index + 1}.mp4`)
				await extractChapterSegmentAccurate({
					inputPath: options.inputPath,
					outputPath: segmentPath,
					start: range.start,
					end: range.end,
				})
				segmentPaths.push(segmentPath)
			}
			if (segmentPaths.length < 2) {
				throw new Error('Expected at least two segments to concat.')
			}
			await concatSegments({
				segmentPaths,
				outputPath: options.outputPath,
			})
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}

		return {
			success: true,
			outputPath: options.outputPath,
			removedRanges,
			keepRanges,
		}
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			removedRanges,
			keepRanges,
		}
	}
}

async function main() {
	const argv = yargs(hideBin(process.argv))
		.scriptName('remove-ranges')
		.option('input', {
			type: 'string',
			demandOption: true,
			describe: 'Input media file',
		})
		.option('ranges', {
			type: 'string',
			demandOption: true,
			describe: 'Comma or space-separated ranges (e.g. 12-15, 1:02-1:05)',
		})
		.option('output', {
			type: 'string',
			describe: 'Output path (defaults to .ranges-removed)',
		})
		.help()
		.parseSync()

	const inputPath = path.resolve(String(argv.input))
	const outputPath =
		typeof argv.output === 'string' && argv.output.trim().length > 0
			? path.resolve(argv.output)
			: buildRangesRemovedOutputPath(inputPath)
	const ranges = parseTimeRanges(String(argv.ranges))
	const result = await removeRangesFromMedia({
		inputPath,
		outputPath,
		ranges,
	})
	if (!result.success) {
		console.error(result.error ?? 'Range removal failed.')
		process.exit(1)
	}
	console.log(`Updated file written to ${outputPath}`)
}

function parseRangeToken(token: string): TimeRange {
	const separator = token.includes('..') ? '..' : '-'
	const parts = token.split(separator)
	if (parts.length !== 2) {
		throw new Error(`Invalid range "${token}". Use start-end format.`)
	}
	const startText = parts[0]?.trim() ?? ''
	const endText = parts[1]?.trim() ?? ''
	if (!startText || !endText) {
		throw new Error(`Invalid range "${token}". Start and end required.`)
	}
	const start = parseTimestamp(startText)
	const end = parseTimestamp(endText)
	if (end <= start) {
		throw new Error(`Invalid range "${token}". End must be after start.`)
	}
	return { start, end }
}

function parseTimestamp(value: string): number {
	const trimmed = value.trim()
	if (!trimmed) {
		throw new Error('Invalid time value.')
	}
	if (!trimmed.includes(':')) {
		const seconds = Number.parseFloat(trimmed)
		if (!Number.isFinite(seconds) || seconds < 0) {
			throw new Error(`Invalid time value "${value}".`)
		}
		return seconds
	}
	const parts = trimmed.split(':')
	if (parts.length < 2 || parts.length > 3) {
		throw new Error(`Invalid time value "${value}".`)
	}
	let totalSeconds = 0
	for (const [index, part] of parts.entries()) {
		const segment = part.trim()
		if (!segment) {
			throw new Error(`Invalid time value "${value}".`)
		}
		if (segment.includes('.') && index < parts.length - 1) {
			throw new Error(`Invalid time value "${value}".`)
		}
		const numberValue = Number.parseFloat(segment)
		if (!Number.isFinite(numberValue) || numberValue < 0) {
			throw new Error(`Invalid time value "${value}".`)
		}
		totalSeconds = totalSeconds * 60 + numberValue
	}
	return totalSeconds
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(
			`[error] ${error instanceof Error ? error.message : String(error)}`,
		)
		process.exit(1)
	})
}
