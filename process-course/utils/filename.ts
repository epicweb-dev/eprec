import type { Chapter } from '../types'
import { normalizeFilename, toKebabCase } from '../../utils'

/**
 * Format a chapter into a filename-safe string.
 */
export function formatChapterFilename(chapter: Chapter): string {
	const title = chapter.title ?? `chapter-${chapter.index + 1}`
	const normalized = normalizeFilename(title)
	const slug = toKebabCase(normalized)
	return `chapter-${String(chapter.index + 1).padStart(2, '0')}-${slug}`
}
