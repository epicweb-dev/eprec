import path from 'node:path'
import { formatSeconds } from '../src/utils'
import {
	buildSummaryLogPath,
	buildJarvisWarningLogPath,
	buildJarvisEditLogPath,
	buildJarvisNoteLogPath,
} from './paths'
import { logInfo } from './logging'
import type {
	Chapter,
	JarvisWarning,
	JarvisEdit,
	JarvisNote,
	EditWorkspaceInfo,
} from './types'

export type ProcessingSummary = {
	totalSelected: number
	processed: number
	skippedShortInitial: number
	skippedShortTrimmed: number
	skippedTranscription: number
	fallbackNotes: number
	logsWritten: number
	jarvisWarnings: number
	editsPending: number
}

export async function writeJarvisLogs(options: {
	outputDir: string
	inputPath: string
	jarvisWarnings: JarvisWarning[]
	jarvisEdits: JarvisEdit[]
	jarvisNotes: JarvisNote[]
	editWorkspaces: EditWorkspaceInfo[]
	dryRun: boolean
}) {
	const {
		outputDir,
		inputPath,
		jarvisWarnings,
		jarvisEdits,
		jarvisNotes,
		editWorkspaces,
		dryRun,
	} = options

	const jarvisWarningLogPath = buildJarvisWarningLogPath(outputDir)
	if (dryRun) {
		logInfo(`[dry-run] Would write jarvis warning log: ${jarvisWarningLogPath}`)
	} else {
		const warningLines = [
			`Input: ${inputPath}`,
			`Output dir: ${outputDir}`,
			`Jarvis warnings: ${jarvisWarnings.length}`,
		]
		if (jarvisWarnings.length > 0) {
			warningLines.push('Detected in:')
			jarvisWarnings.forEach((warning) => {
				warningLines.push(
					`- Chapter ${warning.chapter.index + 1}: ${warning.chapter.title} -> ${path.basename(
						warning.outputPath,
					)}`,
				)
				const timestampLabel =
					warning.timestamps.length > 0
						? warning.timestamps
								.map(
									(timestamp) =>
										`${formatSeconds(timestamp.start)}-${formatSeconds(timestamp.end)}`,
								)
								.join(', ')
						: 'unavailable'
				warningLines.push(`  Jarvis timestamps: ${timestampLabel}`)
			})
		} else {
			warningLines.push('Detected in: none')
		}
		await Bun.write(jarvisWarningLogPath, `${warningLines.join('\n')}\n`)
	}

	const jarvisEditLogPath = buildJarvisEditLogPath(outputDir)
	if (dryRun) {
		logInfo(`[dry-run] Would write jarvis edit log: ${jarvisEditLogPath}`)
	} else {
		const editLines = [
			`Input: ${inputPath}`,
			`Output dir: ${outputDir}`,
			`Edit commands: ${jarvisEdits.length}`,
			`Manual edits: ${editWorkspaces.length}`,
		]
		if (jarvisEdits.length > 0) {
			editLines.push('Files needing edits:')
			jarvisEdits.forEach((edit) => {
				editLines.push(
					`- Chapter ${edit.chapter.index + 1}: ${edit.chapter.title} -> ${path.basename(
						edit.outputPath,
					)}`,
				)
			})
		} else {
			editLines.push('Files needing edits: none')
		}
		if (editWorkspaces.length > 0) {
			editLines.push('Edit workspaces:')
			editWorkspaces.forEach((workspace) => {
				editLines.push(
					`- Chapter ${workspace.chapter.index + 1}: ${workspace.chapter.title} -> ${path.basename(
						workspace.outputPath,
					)}`,
				)
				editLines.push(`  Reason: ${workspace.reason}`)
				editLines.push(`  Directory: ${workspace.editsDirectory}`)
			})
		} else {
			editLines.push('Edit workspaces: none')
		}
		await Bun.write(jarvisEditLogPath, `${editLines.join('\n')}\n`)
	}

	const jarvisNoteLogPath = buildJarvisNoteLogPath(outputDir)
	if (dryRun) {
		logInfo(`[dry-run] Would write jarvis note log: ${jarvisNoteLogPath}`)
	} else {
		const noteLines = [
			`Input: ${inputPath}`,
			`Output dir: ${outputDir}`,
			`Note commands: ${jarvisNotes.length}`,
		]
		if (jarvisNotes.length > 0) {
			noteLines.push('Notes:')
			jarvisNotes.forEach((note) => {
				noteLines.push(
					`- Chapter ${note.chapter.index + 1}: ${note.chapter.title} -> ${path.basename(
						note.outputPath,
					)}`,
				)
				noteLines.push(`  Note: ${note.note}`)
			})
		} else {
			noteLines.push('Notes: none')
		}
		await Bun.write(jarvisNoteLogPath, `${noteLines.join('\n')}\n`)
	}
}

export async function writeSummaryLogs(options: {
	tmpDir: string
	outputDir: string
	inputPath: string
	summary: ProcessingSummary
	summaryDetails: string[]
	jarvisWarnings: JarvisWarning[]
	jarvisEdits: JarvisEdit[]
	editWorkspaces: EditWorkspaceInfo[]
	dryRun: boolean
}) {
	const {
		tmpDir,
		outputDir,
		inputPath,
		summary,
		summaryDetails,
		jarvisWarnings,
		jarvisEdits,
		editWorkspaces,
		dryRun,
	} = options

	const summaryLines = [
		`Input: ${inputPath}`,
		`Output dir: ${outputDir}`,
		`Chapters selected: ${summary.totalSelected}`,
		`${dryRun ? 'Would process' : 'Processed'} chapters: ${summary.processed}`,
		`Skipped (short initial): ${summary.skippedShortInitial}`,
		`Skipped (trimmed short): ${summary.skippedShortTrimmed}`,
		`Skipped (transcription): ${summary.skippedTranscription}`,
		`Fallback notes: ${summary.fallbackNotes}`,
		`Log files written: ${summary.logsWritten}`,
		`Jarvis warnings: ${summary.jarvisWarnings}`,
		`Manual edits: ${summary.editsPending}`,
	]
	if (editWorkspaces.length > 0) {
		summaryLines.push('Edit workspaces:')
		editWorkspaces.forEach((workspace) => {
			summaryLines.push(
				`- Chapter ${workspace.chapter.index + 1}: ${workspace.chapter.title} -> ${path.basename(
					workspace.outputPath,
				)}`,
			)
			summaryLines.push(`  Reason: ${workspace.reason}`)
			summaryLines.push(`  Directory: ${workspace.editsDirectory}`)
		})
	}
	if (summaryDetails.length > 0) {
		summaryLines.push('Details:', ...summaryDetails)
	}

	logInfo('Summary:')
	summaryLines.forEach((line) => logInfo(line))

	if (dryRun) {
		const summaryLogPath = buildSummaryLogPath(tmpDir)
		logInfo(`[dry-run] Would write summary log: ${summaryLogPath}`)
	} else {
		const summaryLogPath = buildSummaryLogPath(tmpDir)
		await Bun.write(summaryLogPath, `${summaryLines.join('\n')}\n`)
	}
}
