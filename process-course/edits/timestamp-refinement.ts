import { readAudioSamples } from '../ffmpeg'
import { CONFIG, EDIT_CONFIG } from '../config'
import { clamp } from '../../utils'
import { mergeTimeRanges } from '../utils/time-ranges'
import { findLowestAmplitudeBoundaryProgressive } from '../utils/audio-analysis'
import type { TimeRange } from '../types'
import type { TranscriptWordWithIndex } from './types'

export type RefinedRange = {
	original: TimeRange
	refined: TimeRange
}

export function wordsToTimeRanges(
	words: TranscriptWordWithIndex[],
): TimeRange[] {
	const ranges = words.map((word) => ({ start: word.start, end: word.end }))
	return mergeTimeRanges(ranges)
}

export async function refineRemovalRange(options: {
	inputPath: string
	duration: number
	range: TimeRange
	paddingMs?: number
}): Promise<RefinedRange> {
	const paddingSeconds =
		(options.paddingMs ?? EDIT_CONFIG.speechBoundaryPaddingMs) / 1000
	const silenceStart = await findSilenceBoundary({
		inputPath: options.inputPath,
		duration: options.duration,
		targetTime: options.range.start,
		direction: 'before',
	})
	if (silenceStart === null) {
		throw new Error(
			buildSilenceError({
				direction: 'before',
				targetTime: options.range.start,
				maxWindowSeconds: getMaxSilenceSearchSeconds({
					duration: options.duration,
					targetTime: options.range.start,
					direction: 'before',
				}),
			}),
		)
	}
	const silenceEnd = await findSilenceBoundary({
		inputPath: options.inputPath,
		duration: options.duration,
		targetTime: options.range.end,
		direction: 'after',
	})
	if (silenceEnd === null) {
		throw new Error(
			buildSilenceError({
				direction: 'after',
				targetTime: options.range.end,
				maxWindowSeconds: getMaxSilenceSearchSeconds({
					duration: options.duration,
					targetTime: options.range.end,
					direction: 'after',
				}),
			}),
		)
	}

	const paddedStart = clamp(silenceStart + paddingSeconds, 0, options.duration)
	const paddedEnd = clamp(silenceEnd - paddingSeconds, 0, options.duration)
	const refinedStart =
		paddedStart <= options.range.start ? paddedStart : silenceStart
	const refinedEnd = paddedEnd >= options.range.end ? paddedEnd : silenceEnd

	if (refinedEnd <= refinedStart + 0.005) {
		throw new Error(
			`Unable to create a non-empty cut around ${options.range.start.toFixed(3)}s-${options.range.end.toFixed(3)}s.`,
		)
	}

	return {
		original: options.range,
		refined: { start: refinedStart, end: refinedEnd },
	}
}

export async function refineAllRemovalRanges(options: {
	inputPath: string
	duration: number
	ranges: TimeRange[]
	paddingMs?: number
}): Promise<RefinedRange[]> {
	const refined: RefinedRange[] = []
	for (const range of options.ranges) {
		refined.push(
			await refineRemovalRange({
				inputPath: options.inputPath,
				duration: options.duration,
				range,
				paddingMs: options.paddingMs,
			}),
		)
	}
	return refined
}

type SpeechBoundaryDirection = 'before' | 'after'

async function findSilenceBoundary(options: {
	inputPath: string
	duration: number
	targetTime: number
	direction: SpeechBoundaryDirection
}): Promise<number | null> {
	const maxWindowSeconds = getMaxSilenceSearchSeconds(options)
	if (maxWindowSeconds <= 0.01) {
		return null
	}
	const windowStart =
		options.direction === 'before'
			? Math.max(0, options.targetTime - maxWindowSeconds)
			: options.targetTime
	const windowEnd =
		options.direction === 'before'
			? options.targetTime
			: Math.min(options.duration, options.targetTime + maxWindowSeconds)
	const windowDuration = windowEnd - windowStart
	if (windowDuration <= 0.01) {
		return null
	}
	const samples = await readAudioSamples({
		inputPath: options.inputPath,
		start: windowStart,
		duration: windowDuration,
		sampleRate: CONFIG.vadSampleRate,
	})
	if (samples.length === 0) {
		return null
	}

	const boundary = findLowestAmplitudeBoundaryProgressive({
		samples,
		sampleRate: CONFIG.vadSampleRate,
		direction: options.direction,
		rmsWindowMs: CONFIG.commandSilenceRmsWindowMs,
		rmsThreshold: CONFIG.commandSilenceRmsThreshold,
		startWindowSeconds: EDIT_CONFIG.silenceSearchStartSeconds,
		stepSeconds: EDIT_CONFIG.silenceSearchStepSeconds,
		maxWindowSeconds: windowDuration,
	})
	return boundary === null ? null : windowStart + boundary
}

function buildSilenceError(options: {
	direction: SpeechBoundaryDirection
	targetTime: number
	maxWindowSeconds: number
}): string {
	const directionLabel = options.direction === 'before' ? 'before' : 'after'
	return `No low-amplitude boundary found ${directionLabel} ${options.targetTime.toFixed(3)}s within ${options.maxWindowSeconds.toFixed(2)}s.`
}

function getMaxSilenceSearchSeconds(options: {
	duration: number
	targetTime: number
	direction: SpeechBoundaryDirection
}): number {
	const availableSeconds =
		options.direction === 'before'
			? options.targetTime
			: options.duration - options.targetTime
	return Math.min(EDIT_CONFIG.silenceSearchMaxSeconds, availableSeconds)
}
