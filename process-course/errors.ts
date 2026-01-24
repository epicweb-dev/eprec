// Custom error types for better error handling and debugging

export class ChapterProcessingError extends Error {
	constructor(
		message: string,
		public readonly chapterIndex: number,
		public readonly chapterTitle: string,
	) {
		super(message)
		this.name = 'ChapterProcessingError'
	}
}

export class ChapterTooShortError extends ChapterProcessingError {
	constructor(
		chapterIndex: number,
		chapterTitle: string,
		public readonly duration: number,
		public readonly minDuration: number,
	) {
		super(
			`Chapter "${chapterTitle}" is too short (${duration.toFixed(2)}s < ${minDuration}s)`,
			chapterIndex,
			chapterTitle,
		)
		this.name = 'ChapterTooShortError'
	}
}

export class CommandParseError extends Error {
	constructor(
		message: string,
		public readonly transcript?: string,
	) {
		super(message)
		this.name = 'CommandParseError'
	}
}

export class TranscriptTooShortError extends ChapterProcessingError {
	constructor(
		chapterIndex: number,
		chapterTitle: string,
		public readonly wordCount: number,
		public readonly minWordCount: number,
	) {
		super(
			`Chapter "${chapterTitle}" transcript too short (${wordCount} words < ${minWordCount})`,
			chapterIndex,
			chapterTitle,
		)
		this.name = 'TranscriptTooShortError'
	}
}

export class BadTakeError extends ChapterProcessingError {
	constructor(chapterIndex: number, chapterTitle: string) {
		super(
			`Chapter "${chapterTitle}" marked as bad take`,
			chapterIndex,
			chapterTitle,
		)
		this.name = 'BadTakeError'
	}
}

export class SpliceError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SpliceError'
	}
}

export class TrimWindowError extends Error {
	constructor(
		public readonly start: number,
		public readonly end: number,
	) {
		super(`Trim window too small (${start.toFixed(3)}s -> ${end.toFixed(3)}s)`)
		this.name = 'TrimWindowError'
	}
}
