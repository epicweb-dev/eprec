import path from 'node:path'
import { copyFile, mkdir } from 'node:fs/promises'
import type { TranscriptSegment } from '../../src/whispercpp-transcribe'
import {
	buildTranscriptWordsWithIndices,
	generateTranscriptJson,
	generateTranscriptText,
} from './transcript-output'

export type EditWorkspace = {
	editsDirectory: string
	transcriptTextPath: string
	transcriptJsonPath: string
	originalVideoPath: string
	instructionsPath: string
}

export async function createEditWorkspace(options: {
	outputDir: string
	sourceVideoPath: string
	sourceDuration: number
	segments: TranscriptSegment[]
}): Promise<EditWorkspace> {
	const editsRoot = path.join(options.outputDir, 'edits')
	const parsed = path.parse(options.sourceVideoPath)
	const editsDirectory = path.join(editsRoot, parsed.name)
	await mkdir(editsDirectory, { recursive: true })

	const originalVideoPath = path.join(editsDirectory, `original${parsed.ext}`)
	await copyFile(options.sourceVideoPath, originalVideoPath)

	const words = buildTranscriptWordsWithIndices(options.segments)
	const transcriptTextPath = path.join(editsDirectory, 'transcript.txt')
	const transcriptJsonPath = path.join(editsDirectory, 'transcript.json')
	await Bun.write(transcriptTextPath, generateTranscriptText(words))
	await Bun.write(
		transcriptJsonPath,
		generateTranscriptJson({
			sourceVideo: path.basename(options.sourceVideoPath),
			sourceDuration: options.sourceDuration,
			words,
		}),
	)

	const instructionsPath = path.join(editsDirectory, 'edit-instructions.md')
	await Bun.write(
		instructionsPath,
		buildInstructions({
			editsDirectory,
			originalVideoPath,
			transcriptJsonPath,
			transcriptTextPath,
			outputBasename: `${parsed.name}.edited${parsed.ext}`,
		}),
	)

	return {
		editsDirectory,
		transcriptTextPath,
		transcriptJsonPath,
		originalVideoPath,
		instructionsPath,
	}
}

function buildInstructions(options: {
	editsDirectory: string
	originalVideoPath: string
	transcriptJsonPath: string
	transcriptTextPath: string
	outputBasename: string
}): string {
	return [
		'# Manual edit workflow',
		'',
		'1) Edit `transcript.txt` and delete whole words only.',
		'2) Run:',
		'',
		`   bun process-course/edits/cli.ts edit-video \\`,
		`     --input "${options.originalVideoPath}" \\`,
		`     --transcript "${options.transcriptJsonPath}" \\`,
		`     --edited "${options.transcriptTextPath}" \\`,
		`     --output "${path.join(options.editsDirectory, options.outputBasename)}"`,
		'',
		'If the transcript no longer matches, regenerate it with:',
		'',
		`   bun process-course/edits/regenerate-transcript.ts --dir "${options.editsDirectory}"`,
		'',
	].join('\n')
}
