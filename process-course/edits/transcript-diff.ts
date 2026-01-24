import { normalizeWords } from '../utils/transcript'
import type { TranscriptMismatchError, TranscriptWordWithIndex } from './types'

export type DiffResult = {
	success: boolean
	removedWords: TranscriptWordWithIndex[]
	error?: string
	mismatch?: TranscriptMismatchError
}

export type ValidationResult = {
	valid: boolean
	error?: string
	mismatch?: TranscriptMismatchError
	details?: {
		unexpectedWord: string
		position: number
	}
}

export function diffTranscripts(options: {
	originalWords: TranscriptWordWithIndex[]
	editedText: string
}): DiffResult {
	const validation = validateEditedTranscript(options)
	if (!validation.valid) {
		return {
			success: false,
			removedWords: [],
			error: validation.error,
			mismatch: validation.mismatch,
		}
	}

	const editedWords = tokenizeEditedText(options.editedText)
	const removedWords: TranscriptWordWithIndex[] = []
	let originalIndex = 0
	let editedIndex = 0

	while (originalIndex < options.originalWords.length) {
		const originalWord = options.originalWords[originalIndex]
		if (!originalWord) {
			originalIndex += 1
			continue
		}
		const editedWord = editedWords[editedIndex]
		if (editedWord && originalWord.word === editedWord) {
			originalIndex += 1
			editedIndex += 1
			continue
		}
		removedWords.push(originalWord)
		originalIndex += 1
	}

	if (editedIndex < editedWords.length) {
		const mismatch = buildMismatchError({
			type: 'word_added',
			position: editedIndex,
			editedWord: editedWords[editedIndex],
			originalWord: null,
		})
		return {
			success: false,
			removedWords: [],
			error: mismatch.message,
			mismatch,
		}
	}

	return { success: true, removedWords }
}

export function validateEditedTranscript(options: {
	originalWords: TranscriptWordWithIndex[]
	editedText: string
}): ValidationResult {
	const editedWords = tokenizeEditedText(options.editedText)
	if (options.originalWords.length === 0) {
		return {
			valid: false,
			error: 'Original transcript has no words. Regenerate the transcript.',
		}
	}
	if (editedWords.length === 0) {
		return {
			valid: false,
			error:
				'Edited transcript is empty. Regenerate the transcript if this was unintentional.',
		}
	}

	let originalIndex = 0
	let editedIndex = 0

	while (
		originalIndex < options.originalWords.length &&
		editedIndex < editedWords.length
	) {
		const originalWord = options.originalWords[originalIndex]
		const editedWord = editedWords[editedIndex]
		if (!originalWord || !editedWord) {
			break
		}
		if (originalWord.word === editedWord) {
			originalIndex += 1
			editedIndex += 1
			continue
		}

		const nextMatchIndex = findNextMatchIndex(
			options.originalWords,
			editedWord,
			originalIndex + 1,
		)
		if (nextMatchIndex === -1) {
			const mismatchType = resolveMismatchType(
				options.originalWords,
				editedWord,
				originalIndex,
			)
			const mismatch = buildMismatchError({
				type: mismatchType,
				position: editedIndex,
				editedWord,
				originalWord: originalWord.word,
			})
			return {
				valid: false,
				error: mismatch.message,
				mismatch,
				details: {
					unexpectedWord: editedWord,
					position: editedIndex,
				},
			}
		}
		originalIndex += 1
	}

	if (editedIndex < editedWords.length) {
		const mismatch = buildMismatchError({
			type: 'word_added',
			position: editedIndex,
			editedWord: editedWords[editedIndex],
			originalWord: null,
		})
		return {
			valid: false,
			error: mismatch.message,
			mismatch,
			details: {
				unexpectedWord: editedWords[editedIndex] ?? '',
				position: editedIndex,
			},
		}
	}

	return { valid: true }
}

function tokenizeEditedText(text: string): string[] {
	return normalizeWords(text)
}

function findNextMatchIndex(
	words: TranscriptWordWithIndex[],
	target: string,
	startIndex: number,
): number {
	for (let index = startIndex; index < words.length; index += 1) {
		if (words[index]?.word === target) {
			return index
		}
	}
	return -1
}

function resolveMismatchType(
	words: TranscriptWordWithIndex[],
	editedWord: string,
	originalIndex: number,
): TranscriptMismatchError['type'] {
	const anyIndex = words.findIndex((word) => word.word === editedWord)
	if (anyIndex >= 0 && anyIndex < originalIndex) {
		return 'word_out_of_order'
	}
	return anyIndex >= 0 ? 'word_out_of_order' : 'word_modified'
}

function buildMismatchError(options: {
	type: TranscriptMismatchError['type']
	position: number
	editedWord: string | undefined
	originalWord: string | null
}): TranscriptMismatchError {
	const expected =
		options.originalWord === null ? 'end of transcript' : options.originalWord
	const found = options.editedWord ?? 'end of transcript'
	const typeLabel =
		options.type === 'word_added'
			? 'Unexpected word'
			: options.type === 'word_out_of_order'
				? 'Word out of order'
				: 'Word modified'
	const message = `Error: Transcript mismatch at word position ${options.position}.\nExpected: "${expected}"\nFound: "${found}"\n\nThe edited transcript contains changes that don't match the original.\nPlease regenerate the transcript and try again.`
	return {
		type: options.type,
		position: options.position,
		originalWord: options.originalWord ?? undefined,
		editedWord: options.editedWord ?? undefined,
		message: `${typeLabel}. ${message}`,
	}
}
