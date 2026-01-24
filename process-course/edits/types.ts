export type TranscriptWordWithIndex = {
	word: string
	start: number
	end: number
	index: number
}

export type TranscriptJson = {
	version: 1
	source_video: string
	source_duration: number
	words: TranscriptWordWithIndex[]
}

export type TranscriptMismatchType =
	| 'word_added'
	| 'word_modified'
	| 'word_out_of_order'

export type TranscriptMismatchError = {
	type: TranscriptMismatchType
	position: number
	originalWord?: string
	editedWord?: string
	message: string
}
