import type { TranscriptSegment } from '../../whispercpp-transcribe'
import { buildTranscriptWords } from '../jarvis-commands/parser'
import type { TranscriptJson, TranscriptWordWithIndex } from './types'

export function buildTranscriptWordsWithIndices(
	segments: TranscriptSegment[],
): TranscriptWordWithIndex[] {
	const words = buildTranscriptWords(segments)
	return words.map((word, index) => ({
		...word,
		index,
	}))
}

export function generateTranscriptText(
	words: TranscriptWordWithIndex[],
): string {
	if (words.length === 0) {
		return ''
	}
	return `${words.map((word) => word.word).join(' ')}\n`
}

export function generateTranscriptJson(options: {
	sourceVideo: string
	sourceDuration: number
	words: TranscriptWordWithIndex[]
}): string {
	const payload: TranscriptJson = {
		version: 1,
		source_video: options.sourceVideo,
		source_duration: options.sourceDuration,
		words: options.words,
	}
	return `${JSON.stringify(payload, null, 2)}\n`
}
