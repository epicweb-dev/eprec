import { test, expect } from 'bun:test'
import type { TranscriptSegment } from '../../whispercpp-transcribe'
import {
	buildTranscriptWordsWithIndices,
	generateTranscriptJson,
	generateTranscriptText,
} from './transcript-output'

function createSegment(
	start: number,
	end: number,
	text: string,
): TranscriptSegment {
	return { start, end, text }
}

test('buildTranscriptWordsWithIndices assigns indices in order', () => {
	const segments = [createSegment(0, 2, 'Hello world')]
	const words = buildTranscriptWordsWithIndices(segments)
	expect(words).toHaveLength(2)
	expect(words[0]).toMatchObject({ word: 'hello', index: 0, start: 0, end: 1 })
	expect(words[1]).toMatchObject({ word: 'world', index: 1, start: 1, end: 2 })
})

test('generateTranscriptText returns readable prose', () => {
	const segments = [createSegment(0, 2, 'Hello world')]
	const words = buildTranscriptWordsWithIndices(segments)
	expect(generateTranscriptText(words)).toBe('hello world\n')
})

test('generateTranscriptJson outputs valid metadata', () => {
	const segments = [createSegment(0, 2, 'Hello world')]
	const words = buildTranscriptWordsWithIndices(segments)
	const json = generateTranscriptJson({
		sourceVideo: 'chapter-01.mp4',
		sourceDuration: 2,
		words,
	})
	const parsed = JSON.parse(json) as {
		version: number
		source_video: string
		source_duration: number
		words: Array<{ word: string; start: number; end: number; index: number }>
	}
	expect(parsed.version).toBe(1)
	expect(parsed.source_video).toBe('chapter-01.mp4')
	expect(parsed.source_duration).toBe(2)
	expect(parsed.words).toHaveLength(2)
	expect(parsed.words[0]).toHaveProperty('word', 'hello')
})
