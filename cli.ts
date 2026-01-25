#!/usr/bin/env bun
import path from 'node:path'
import type { Arguments, CommandBuilder, CommandHandler } from 'yargs'
import yargs from 'yargs/yargs'
import { hideBin } from 'yargs/helpers'
import { startAppServer } from './app-server'
import { setLogHooks } from './process-course/logging'
import { ensureFfmpegAvailable } from './process-course/ffmpeg'
import {
	VIDEO_EXTENSIONS,
	normalizeProcessArgs,
	configureProcessCommand,
} from './process-course/cli'
import { runProcessCourse } from './process-course-video'
import {
	configureEditVideoCommand,
	configureCombineVideosCommand,
	createCombineVideosHandler,
	createEditVideoHandler,
} from './process-course/edits/cli'
import { detectSpeechSegmentsForFile } from './speech-detection'
import {
	getDefaultWhisperModelPath,
	transcribeAudio,
} from './whispercpp-transcribe'
import {
	PromptCancelled,
	createInquirerPrompter,
	createPathPicker,
	isInteractive,
	pauseActiveSpinner,
	resumeActiveSpinner,
	resolveOptionalString,
	type PathPicker,
	type Prompter,
	withSpinner,
} from './cli-ux'

type CliUxContext = {
	interactive: boolean
	prompter?: Prompter
	pathPicker?: PathPicker
}

async function main(rawArgs = hideBin(process.argv)) {
	const context = createCliUxContext()
	let args = rawArgs

	if (context.interactive && args.length === 0 && context.prompter) {
		const selection = await promptForCommand(context.prompter)
		if (!selection) {
			return
		}
		args = selection
	}

	const handlerOptions = {
		interactive: context.interactive,
		pathPicker: context.pathPicker,
	}

	const parser = yargs(args)
		.scriptName('eprec')
		.command(
			'process [input...]',
			'Process chapters into separate files',
			configureProcessCommand,
			async (argv) => {
				const processArgs = await resolveProcessArgs(argv, context)
				await withSpinner(
					'Processing course',
					async () => {
						setLogHooks({
							beforeLog: pauseActiveSpinner,
							afterLog: resumeActiveSpinner,
						})
						try {
							await runProcessCourse(processArgs)
						} finally {
							setLogHooks({})
						}
					},
					{ successText: 'Processing complete', enabled: context.interactive },
				)
			},
		)
		.command(
			'edit',
			'Edit a single video using transcript text edits',
			configureEditVideoCommand as CommandBuilder,
			createEditVideoHandler(handlerOptions) as CommandHandler,
		)
		.command(
			'combine',
			'Combine two videos with speech-aligned padding',
			configureCombineVideosCommand as CommandBuilder,
			createCombineVideosHandler(handlerOptions) as CommandHandler,
		)
		.command(
			'app start',
			'Start the web UI server',
			(command) =>
				command
					.option('port', {
						type: 'number',
						describe: 'Port for the app server',
					})
					.option('host', {
						type: 'string',
						describe: 'Host to bind for the app server',
					}),
			async (argv) => {
				const port =
					typeof argv.port === 'number' && Number.isFinite(argv.port)
						? argv.port
						: undefined
				const host = resolveOptionalString(argv.host)
				await startAppServer({ port, host })
			},
		)
		.command(
			'transcribe [input]',
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
				const transcribeArgs = await resolveTranscribeArgs(argv, context)
				let resultText = ''
				await withSpinner(
					'Transcribing audio',
					async () => {
						const result = await transcribeAudio(transcribeArgs.inputPath, {
							modelPath: transcribeArgs.modelPath,
							language: transcribeArgs.language,
							threads: transcribeArgs.threads,
							binaryPath: transcribeArgs.binaryPath,
							outputBasePath: transcribeArgs.outputBasePath,
						})
						resultText = result.text
					},
					{ successText: 'Transcription complete', enabled: context.interactive },
				)
				console.log(
					`Transcript written to ${transcribeArgs.outputBasePath}.txt`,
				)
				console.log(
					`Segments written to ${transcribeArgs.outputBasePath}.json`,
				)
				console.log(resultText)
			},
		)
		.command(
			'detect-speech [input]',
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
				const { inputPath, start, end } = await resolveDetectSpeechArgs(
					argv,
					context,
				)
				let segments: unknown = []
				await withSpinner(
					'Detecting speech',
					async () => {
						await ensureFfmpegAvailable()
						segments = await detectSpeechSegmentsForFile({
							inputPath,
							start,
							end,
						})
					},
					{ successText: 'Speech detection complete', enabled: context.interactive },
				)
				console.log(JSON.stringify(segments, null, 2))
			},
		)
		.demandCommand(1)
		.strict()
		.help()

	await parser.parseAsync()
}

function createCliUxContext(): CliUxContext {
	const interactive = isInteractive()
	if (!interactive) {
		return { interactive }
	}
	const prompter = createInquirerPrompter()
	const pathPicker = createPathPicker(prompter)
	return { interactive, prompter, pathPicker }
}

async function promptForCommand(
	prompter: Prompter,
): Promise<string[] | null> {
	const selection = await prompter.select('Choose a command', [
		{
			name: 'Process chapters into separate files',
			value: 'process',
		},
		{
			name: 'Edit a single video using transcript text edits',
			value: 'edit',
		},
		{
			name: 'Combine two videos with speech-aligned padding',
			value: 'combine',
		},
		{
			name: 'Start the web UI server',
			value: 'app-start',
		},
		{
			name: 'Transcribe a single audio/video file',
			value: 'transcribe',
		},
		{
			name: 'Show detected speech segments for a file',
			value: 'detect-speech',
		},
		{ name: 'Show help', value: 'help' },
		{ name: 'Exit', value: 'exit' },
	])
	switch (selection) {
		case 'exit':
			return null
		case 'help':
			return ['--help']
		case 'app-start':
			return ['app', 'start']
		default:
			return [selection]
	}
}

async function resolveProcessArgs(argv: Arguments, context: CliUxContext) {
	let inputPaths = collectStringArray(argv.input)
	if (inputPaths.length === 0) {
		if (!context.interactive || !context.pathPicker || !context.prompter) {
			throw new Error('At least one input file is required.')
		}
		inputPaths = await promptForInputFiles(context)
	}

	let outputDir = resolveOptionalString(argv['output-dir'])
	if (!outputDir && context.interactive && context.prompter && context.pathPicker) {
		const chooseOutput = await context.prompter.confirm(
			'Choose a custom output directory?',
			{ defaultValue: false },
		)
		if (chooseOutput) {
			outputDir = await context.pathPicker.pickExistingDirectory({
				message: 'Select output directory',
			})
		}
	}

	const updatedArgs = {
		...argv,
		input: inputPaths,
		'output-dir': outputDir ?? argv['output-dir'],
	} as Arguments
	return normalizeProcessArgs(updatedArgs)
}

async function promptForInputFiles(context: CliUxContext) {
	if (!context.prompter || !context.pathPicker) {
		throw new Error('Interactive prompts are not available.')
	}
	const inputPaths: string[] = []
	let addAnother = true
	while (addAnother) {
		const inputPath = await context.pathPicker.pickExistingFile({
			message:
				inputPaths.length === 0
					? 'Select input video file'
					: 'Select another input video file',
			extensions: VIDEO_EXTENSIONS,
		})
		inputPaths.push(inputPath)
		addAnother = await context.prompter.confirm('Add another input file?', {
			defaultValue: false,
		})
	}
	return inputPaths
}

async function resolveTranscribeArgs(argv: Arguments, context: CliUxContext) {
	let input = resolveOptionalString(argv.input)
	if (!input) {
		if (!context.interactive || !context.pathPicker) {
			throw new Error('Input audio/video file is required.')
		}
		input = await context.pathPicker.pickExistingFile({
			message: 'Select input audio/video file',
		})
	}
	const inputPath = path.resolve(input)
	const outputBasePath =
		resolveOptionalString(argv['output-base']) ??
		buildTranscribeOutputBase(inputPath)
	const threads = resolveOptionalNumber(argv.threads)
	return {
		inputPath,
		outputBasePath,
		threads,
		modelPath: resolveOptionalString(argv['model-path']),
		language: resolveOptionalString(argv.language),
		binaryPath: resolveOptionalString(argv['binary-path']),
	}
}

async function resolveDetectSpeechArgs(argv: Arguments, context: CliUxContext) {
	let input = resolveOptionalString(argv.input)
	if (!input) {
		if (!context.interactive || !context.pathPicker) {
			throw new Error('Input audio/video file is required.')
		}
		input = await context.pathPicker.pickExistingFile({
			message: 'Select input audio/video file',
		})
	}
	return {
		inputPath: String(input),
		start: resolveOptionalNumber(argv.start),
		end: resolveOptionalNumber(argv.end),
	}
}

function buildTranscribeOutputBase(inputPath: string) {
	return path.join(
		path.dirname(inputPath),
		`${path.parse(inputPath).name}-transcript`,
	)
}

function collectStringArray(value: unknown) {
	if (Array.isArray(value)) {
		return value.filter(
			(entry): entry is string =>
				typeof entry === 'string' && entry.trim().length > 0,
		)
	}
	if (typeof value === 'string' && value.trim().length > 0) {
		return [value]
	}
	return []
}

function resolveOptionalNumber(value: unknown) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined
	}
	return value
}

main().catch((error) => {
	if (error instanceof PromptCancelled) {
		console.log('[info] Cancelled.')
		return
	}
	console.error(
		`[error] ${error instanceof Error ? error.message : String(error)}`,
	)
	process.exit(1)
})
