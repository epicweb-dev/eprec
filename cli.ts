#!/usr/bin/env bun
import path from 'node:path'
import type { CommandBuilder, CommandHandler } from 'yargs'
import yargs from 'yargs/yargs'
import { hideBin } from 'yargs/helpers'
import { ensureFfmpegAvailable } from './process-course/ffmpeg'
import {
	normalizeProcessArgs,
	configureProcessCommand,
} from './process-course/cli'
import { runProcessCourse } from './process-course-video'
import {
	configureEditVideoCommand,
	configureCombineVideosCommand,
	handleCombineVideosCommand,
	handleEditVideoCommand,
} from './process-course/edits/cli'
import { detectSpeechSegmentsForFile } from './speech-detection'
import {
	getDefaultWhisperModelPath,
	transcribeAudio,
} from './whispercpp-transcribe'

function resolveOptionalString(value: unknown) {
	if (typeof value !== 'string') {
		return undefined
	}
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

async function main() {
	const parser = yargs(hideBin(process.argv))
		.scriptName('eprec')
		.command(
			'process <input...>',
			'Process chapters into separate files',
			configureProcessCommand,
			async (argv) => {
				const args = normalizeProcessArgs(argv)
				await runProcessCourse(args)
			},
		)
		.command(
			'edit',
			'Edit a single video using transcript text edits',
			configureEditVideoCommand as CommandBuilder,
			handleEditVideoCommand as CommandHandler,
		)
		.command(
			'combine',
			'Combine two videos with speech-aligned padding',
			configureCombineVideosCommand as CommandBuilder,
			handleCombineVideosCommand as CommandHandler,
		)
		.command(
			'transcribe <input>',
			'Transcribe a single audio/video file',
			(command) =>
				command
					.positional('input', {
						type: 'string',
						describe: 'Input audio/video file',
					})
					.option('model-path', {
						type: 'string',
						describe: 'Path to whisper.cpp model file',
						default: getDefaultWhisperModelPath(),
					})
					.option('language', {
						type: 'string',
						describe: 'Language passed to whisper.cpp',
						default: 'en',
					})
					.option('threads', {
						type: 'number',
						describe: 'Thread count for whisper.cpp',
					})
					.option('binary-path', {
						type: 'string',
						describe: 'Path to whisper.cpp CLI (whisper-cli)',
					})
					.option('output-base', {
						type: 'string',
						describe: 'Output base path (without extension)',
					}),
			async (argv) => {
				const inputPath = path.resolve(String(argv.input))
				const outputBasePath =
					resolveOptionalString(argv['output-base']) ??
					path.join(
						path.dirname(inputPath),
						`${path.parse(inputPath).name}-transcript`,
					)
				const threads =
					typeof argv.threads === 'number' && Number.isFinite(argv.threads)
						? argv.threads
						: undefined
				const result = await transcribeAudio(inputPath, {
					modelPath: resolveOptionalString(argv['model-path']),
					language: resolveOptionalString(argv.language),
					threads,
					binaryPath: resolveOptionalString(argv['binary-path']),
					outputBasePath,
				})
				console.log(`Transcript written to ${outputBasePath}.txt`)
				console.log(`Segments written to ${outputBasePath}.json`)
				console.log(result.text)
			},
		)
		.command(
			'detect-speech <input>',
			'Show detected speech segments for a file',
			(command) =>
				command
					.positional('input', {
						type: 'string',
						describe: 'Input audio/video file',
					})
					.option('start', {
						type: 'number',
						describe: 'Start time in seconds',
					})
					.option('end', {
						type: 'number',
						describe: 'End time in seconds',
					}),
			async (argv) => {
				await ensureFfmpegAvailable()
				const segments = await detectSpeechSegmentsForFile({
					inputPath: String(argv.input),
					start: typeof argv.start === 'number' ? argv.start : undefined,
					end: typeof argv.end === 'number' ? argv.end : undefined,
				})
				console.log(JSON.stringify(segments, null, 2))
			},
		)
		.demandCommand(1)
		.strict()
		.help()

	await parser.parseAsync()
}

main().catch((error) => {
	console.error(
		`[error] ${error instanceof Error ? error.message : String(error)}`,
	)
	process.exit(1)
})
