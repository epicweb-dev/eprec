export type ChapterStatus = 'ready' | 'review' | 'skipped'

export type ChapterPlan = {
	id: string
	title: string
	start: number
	end: number
	status: ChapterStatus
	outputName: string
	notes: string
}

export type CommandAction = 'remove' | 'rename' | 'skip'

export type CommandWindow = {
	id: string
	label: string
	start: number
	end: number
	action: CommandAction
	chapterId: string
	value?: string
	summary: string
}

export type CutRange = {
	id: string
	start: number
	end: number
	reason: string
	source: 'command' | 'manual'
	sourceId?: string
}

export type TranscriptWord = {
	index: number
	word: string
	start: number
	end: number
}

export type EditSession = {
	sourceName: string
	duration: number
	chapters: ChapterPlan[]
	commands: CommandWindow[]
	cuts: CutRange[]
	transcript: TranscriptWord[]
}

const transcriptWords = buildTranscriptWords(
	[
		'chapter',
		'one',
		'normal',
		'processing',
		'starts',
		'here',
		'we',
		'trim',
		'dead',
		'air',
		'and',
		'keep',
		'the',
		'pacing',
		'tight',
		'next',
		'we',
		'mark',
		'the',
		'command',
		'window',
		'jarvis',
		'bad',
		'take',
		'thanks',
		'reset',
		'the',
		'scene',
		'with',
		'clean',
		'audio',
		'chapter',
		'two',
		'dives',
		'into',
		'editing',
		'workflow',
		'jarvis',
		'filename',
		'normal',
		'processing',
		'thanks',
		'we',
		'call',
		'out',
		'transcript',
		'search',
		'markers',
		'for',
		'fast',
		'cleanup',
		'chapter',
		'three',
		'covers',
		'timeline',
		'refinement',
		'jarvis',
		'retake',
		'thanks',
		'wrap',
		'up',
		'notes',
		'and',
		'export',
		'ready',
	],
	4.2,
	2.8,
)

export const sampleEditSession: EditSession = {
	sourceName: 'chapter-01-normal-processing.mp4',
	duration: 240.5,
	chapters: [
		{
			id: 'chapter-01',
			title: 'Intro and setup',
			start: 0,
			end: 62.4,
			status: 'ready',
			outputName: 'chapter-01-intro-and-setup.mp4',
			notes: 'Trimmed silence is already applied.',
		},
		{
			id: 'chapter-02',
			title: 'Editing workflow',
			start: 62.4,
			end: 124.8,
			status: 'review',
			outputName: 'chapter-02-editing-workflow.mp4',
			notes: 'Rename requested via Jarvis command.',
		},
		{
			id: 'chapter-03',
			title: 'Timeline refinement',
			start: 124.8,
			end: 188.2,
			status: 'ready',
			outputName: 'chapter-03-timeline-refinement.mp4',
			notes: 'Includes two command windows to remove.',
		},
		{
			id: 'chapter-04',
			title: 'Wrap up and export',
			start: 188.2,
			end: 240.5,
			status: 'review',
			outputName: 'chapter-04-wrap-up.mp4',
			notes: 'Consider skipping due to retake.',
		},
	],
	commands: [
		{
			id: 'cmd-rename-02',
			label: 'jarvis filename normal-processing thanks',
			start: 71.2,
			end: 75.6,
			action: 'rename',
			chapterId: 'chapter-02',
			value: 'chapter-02-normal-processing.mp4',
			summary: 'Rename chapter 2 output to highlight normal processing.',
		},
		{
			id: 'cmd-bad-take-03',
			label: 'jarvis bad take thanks',
			start: 143.8,
			end: 149.1,
			action: 'remove',
			chapterId: 'chapter-03',
			summary: 'Remove the command window before the retake.',
		},
		{
			id: 'cmd-skip-04',
			label: 'jarvis bad take thanks',
			start: 192,
			end: 195.2,
			action: 'skip',
			chapterId: 'chapter-04',
			summary: 'Mark the outro chapter as skipped.',
		},
		{
			id: 'cmd-retake-04',
			label: 'jarvis retake thanks',
			start: 210.5,
			end: 214.9,
			action: 'remove',
			chapterId: 'chapter-04',
			summary: 'Cut a retake marker from the outro.',
		},
	],
	cuts: [
		{
			id: 'cut-01',
			start: 32.4,
			end: 33.7,
			reason: 'Manual: remove mic pop before intro.',
			source: 'manual',
		},
		{
			id: 'cut-02',
			start: 143.8,
			end: 149.1,
			reason: 'Jarvis command window (bad take).',
			source: 'command',
			sourceId: 'cmd-bad-take-03',
		},
		{
			id: 'cut-03',
			start: 210.5,
			end: 214.9,
			reason: 'Jarvis command window (retake).',
			source: 'command',
			sourceId: 'cmd-retake-04',
		},
	],
	transcript: transcriptWords,
}

function buildTranscriptWords(
	words: string[],
	startAt: number,
	step: number,
): TranscriptWord[] {
	return words.map((word, index) => {
		const start = startAt + index * step
		return {
			index,
			word,
			start,
			end: start + step * 0.7,
		}
	})
}
