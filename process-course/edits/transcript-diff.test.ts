import { test, expect } from 'bun:test'
import { diffTranscripts, validateEditedTranscript } from './transcript-diff'
import type { TranscriptWordWithIndex } from './types'

function createWord(
	word: string,
	index: number,
	start = index * 0.5,
	end = start + 0.4,
): TranscriptWordWithIndex {
	return { word, index, start, end }
}

function createWords(...words: string[]): TranscriptWordWithIndex[] {
	return words.map((word, index) => createWord(word, index))
}

test('diffTranscripts removes words from the middle', () => {
	const originalWords = createWords('hello', 'this', 'is', 'a', 'test')
	const result = diffTranscripts({
		originalWords,
		editedText: 'hello this a test',
	})
	expect(result.success).toBe(true)
	expect(result.removedWords.map((word) => word.word)).toEqual(['is'])
})

test('diffTranscripts removes words at the start', () => {
	const originalWords = createWords('hello', 'this', 'is', 'a', 'test')
	const result = diffTranscripts({
		originalWords,
		editedText: 'this is a test',
	})
	expect(result.success).toBe(true)
	expect(result.removedWords.map((word) => word.word)).toEqual(['hello'])
})

test('diffTranscripts removes words at the end', () => {
	const originalWords = createWords('hello', 'this', 'is', 'a', 'test')
	const result = diffTranscripts({
		originalWords,
		editedText: 'hello this is a',
	})
	expect(result.success).toBe(true)
	expect(result.removedWords.map((word) => word.word)).toEqual(['test'])
})

test('diffTranscripts removes multiple disjoint words', () => {
	const originalWords = createWords('hello', 'this', 'is', 'a', 'test', 'today')
	const result = diffTranscripts({
		originalWords,
		editedText: 'hello is test today',
	})
	expect(result.success).toBe(true)
	expect(result.removedWords.map((word) => word.word)).toEqual(['this', 'a'])
})

test('validateEditedTranscript errors on added words', () => {
	const originalWords = createWords('hello', 'world')
	const result = validateEditedTranscript({
		originalWords,
		editedText: 'hello brave world',
	})
	expect(result.valid).toBe(false)
	expect(result.error).toContain('Transcript mismatch')
})

test('validateEditedTranscript errors on modified words', () => {
	const originalWords = createWords('processing', 'pipeline')
	const result = validateEditedTranscript({
		originalWords,
		editedText: 'prosessing pipeline',
	})
	expect(result.valid).toBe(false)
	expect(result.error).toContain('Transcript mismatch')
})

test('validateEditedTranscript errors on empty edited text', () => {
	const originalWords = createWords('hello', 'world')
	const result = validateEditedTranscript({
		originalWords,
		editedText: '   ',
	})
	expect(result.valid).toBe(false)
})

test('diffTranscripts ignores whitespace differences', () => {
	const originalWords = createWords('hello', 'world')
	const result = diffTranscripts({
		originalWords,
		editedText: 'hello\n  world\t',
	})
	expect(result.success).toBe(true)
	expect(result.removedWords).toHaveLength(0)
})

test('diffTranscripts is case insensitive', () => {
	const originalWords = createWords('hello', 'world')
	const result = diffTranscripts({
		originalWords,
		editedText: 'Hello WORLD',
	})
	expect(result.success).toBe(true)
	expect(result.removedWords).toHaveLength(0)
})
