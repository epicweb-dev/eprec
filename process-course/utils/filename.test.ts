import { test, expect } from 'bun:test'
import type { Chapter } from '../types'
import { formatChapterFilename } from './filename'

function createChapter(index: number, title?: string): Chapter {
	return {
		index,
		start: 0,
		end: 10,
		title: title as string,
	}
}

test('formatChapterFilename uses padded index and kebab-case title', () => {
	const chapter = createChapter(0, 'Intro to React')
	expect(formatChapterFilename(chapter)).toBe('chapter-01-intro-to-react')
})

test('formatChapterFilename falls back to chapter-N when title missing', () => {
	const chapter = createChapter(2, undefined)
	expect(formatChapterFilename(chapter)).toBe('chapter-03-chapter-3')
})

test('formatChapterFilename normalizes number words and dots', () => {
	const chapter = createChapter(0, 'Lesson One point Five')
	expect(formatChapterFilename(chapter)).toBe('chapter-01-lesson-0105')
})
