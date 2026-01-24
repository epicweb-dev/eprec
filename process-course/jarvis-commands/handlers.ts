import { CONFIG } from '../config'
import { countTranscriptWords } from '../utils/transcript'
import type { TranscriptCommand, CommandAnalysisResult } from './types'

/**
 * Analyze commands and determine chapter processing behavior.
 */
export function analyzeCommands(
	commands: TranscriptCommand[],
	transcript: string,
): CommandAnalysisResult {
	const filenameCommand = commands.find(
		(command) => command.type === 'filename' && command.value?.trim(),
	)
	const filenameOverride = filenameCommand?.value ?? null

	const hasBadTake = commands.some((command) => command.type === 'bad-take')
	const hasEdit = commands.some((command) => command.type === 'edit')
	const hasCombinePrevious = commands.some(
		(command) => command.type === 'combine-previous',
	)

	const notes = commands
		.filter((command) => command.type === 'note' && command.value?.trim())
		.map((command) => ({
			value: command.value!,
			window: command.window,
		}))

	const splits = commands
		.filter((command) => command.type === 'split')
		.map((command) => ({
			window: command.window,
		}))

	const transcriptWordCount = countTranscriptWords(transcript)

	// Determine if we should skip this chapter
	let shouldSkip = false
	let skipReason: string | undefined

	if (
		transcriptWordCount <= CONFIG.minTranscriptWords &&
		commands.length === 0
	) {
		shouldSkip = true
		skipReason = `transcript too short (${transcriptWordCount} words)`
	} else if (hasBadTake) {
		shouldSkip = true
		skipReason = 'bad take command detected'
	}

	return {
		commands,
		filenameOverride,
		hasBadTake,
		hasEdit,
		hasCombinePrevious,
		notes,
		splits,
		shouldSkip,
		skipReason,
	}
}

/**
 * Get command types as a comma-separated string for logging.
 */
export function formatCommandTypes(commands: TranscriptCommand[]): string {
	return commands.map((command) => command.type).join(', ')
}
