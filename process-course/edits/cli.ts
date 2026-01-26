#!/usr/bin/env bun
import path from 'node:path'
import type { Argv, Arguments, CommandBuilder, CommandHandler } from 'yargs'
import yargs from 'yargs/yargs'
import { hideBin } from 'yargs/helpers'
import {
	PromptCancelled,
	createInquirerPrompter,
	createPathPicker,
	isInteractive,
	resolveOptionalString,
	type PathPicker,
	type Prompter,
	withSpinner,
} from '../../cli-ux'
import { editVideo, buildEditedOutputPath } from './video-editor'
import { combineVideos } from './combined-video-editor'

export type EditVideoCommandArgs = {
	input: string
	transcript: string
	edited: string
	output?: string
	'padding-ms'?: number
}

export type CombineVideosCommandArgs = {
	video1: string
	transcript1?: string
	edited1?: string
	video2: string
	transcript2?: string
	edited2?: string
	output: string
	'padding-ms'?: number
}

type CliUxOptions = {
	interactive: boolean
	pathPicker?: PathPicker
}

export function buildCombinedOutputPath(
	video1Path: string,
	video2Path: string,
) {
	const dir = path.dirname(video1Path)
	const ext = path.extname(video1Path) || path.extname(video2Path) || '.mp4'
	const name1 = path.parse(video1Path).name
	const name2 = path.parse(video2Path).name
	return path.join(dir, `combined-${name1}-${name2}${ext}`)
}

export async function resolveEditVideoArgs(
	argv: Arguments,
	options: CliUxOptions,
): Promise<EditVideoCommandArgs> {
	const pathPicker = options.pathPicker
	let input = resolveOptionalString(argv.input)
	if (!input) {
		if (!options.interactive || !pathPicker) {
			throw new Error('Input video path is required.')
		}
		input = await pathPicker.pickExistingFile({
			message: 'Select input video file',
		})
	}
	let transcript = resolveOptionalString(argv.transcript)
	if (!transcript) {
		if (!options.interactive || !pathPicker) {
			throw new Error('Transcript JSON path is required.')
		}
		transcript = await pathPicker.pickExistingFile({
			message: 'Select transcript JSON file',
		})
	}
	let edited = resolveOptionalString(argv.edited)
	if (!edited) {
		if (!options.interactive || !pathPicker) {
			throw new Error('Edited transcript path is required.')
		}
		edited = await pathPicker.pickExistingFile({
			message: 'Select edited transcript text file',
		})
	}
	const defaultOutputPath = buildEditedOutputPath(input)
	const outputPath = resolveOptionalString(argv.output) ?? defaultOutputPath
	const paddingMs = resolvePaddingMs(argv['padding-ms'])

	return {
		input,
		transcript,
		edited,
		output: outputPath,
		'padding-ms': paddingMs,
	}
}

export async function resolveCombineVideosArgs(
	argv: Arguments,
	options: CliUxOptions,
): Promise<CombineVideosCommandArgs> {
	const pathPicker = options.pathPicker
	let video1 = resolveOptionalString(argv.video1)
	if (!video1) {
		if (!options.interactive || !pathPicker) {
			throw new Error('First video path is required.')
		}
		video1 = await pathPicker.pickExistingFile({
			message: 'Select first video',
		})
	}
	let video2 = resolveOptionalString(argv.video2)
	if (!video2) {
		if (!options.interactive || !pathPicker) {
			throw new Error('Second video path is required.')
		}
		video2 = await pathPicker.pickExistingFile({
			message: 'Select second video',
		})
	}
	let transcript1 = resolveOptionalString(argv.transcript1)
	let transcript2 = resolveOptionalString(argv.transcript2)
	const edited1 = resolveOptionalString(argv.edited1)
	const edited2 = resolveOptionalString(argv.edited2)

	if (edited1 && !transcript1) {
		if (!options.interactive || !pathPicker) {
			throw new Error('Transcript JSON is required for edited1.')
		}
		transcript1 = await pathPicker.pickExistingFile({
			message: 'Select transcript JSON for first video',
		})
	}
	if (edited2 && !transcript2) {
		if (!options.interactive || !pathPicker) {
			throw new Error('Transcript JSON is required for edited2.')
		}
		transcript2 = await pathPicker.pickExistingFile({
			message: 'Select transcript JSON for second video',
		})
	}

	let output = resolveOptionalString(argv.output)
	if (!output) {
		if (options.interactive && pathPicker) {
			output = await pathPicker.pickOutputPath({
				message: 'Select output video path',
				defaultPath: buildCombinedOutputPath(video1, video2),
			})
		} else {
			output = buildCombinedOutputPath(video1, video2)
		}
	}
	const paddingMs = resolvePaddingMs(argv['padding-ms'])

	return {
		video1,
		transcript1,
		edited1,
		video2,
		transcript2,
		edited2,
		output,
		'padding-ms': paddingMs,
	}
}

function resolvePaddingMs(value: unknown) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined
	}
	return value
}

export function createEditVideoHandler(options: CliUxOptions): CommandHandler {
	return async (argv) => {
		const args = await resolveEditVideoArgs(argv, options)
		await withSpinner(
			'Editing video',
			async () => {
				const result = await editVideo({
					inputPath: String(args.input),
					transcriptJsonPath: String(args.transcript),
					editedTextPath: String(args.edited),
					outputPath: String(args.output),
					paddingMs: args['padding-ms'],
				})
				if (!result.success) {
					throw new Error(result.error ?? 'Edit failed.')
				}
			},
			{ successText: 'Edit complete' },
		)
		console.log(`Edited video written to ${args.output}`)
	}
}

export function createCombineVideosHandler(
	options: CliUxOptions,
): CommandHandler {
	return async (argv) => {
		const args = await resolveCombineVideosArgs(argv, options)
		let outputPath = ''
		await withSpinner(
			'Combining videos',
			async () => {
				const result = await combineVideos({
					video1Path: String(args.video1),
					video1TranscriptJsonPath: args.transcript1,
					video1EditedTextPath: args.edited1,
					video2Path: String(args.video2),
					video2TranscriptJsonPath: args.transcript2,
					video2EditedTextPath: args.edited2,
					outputPath: String(args.output),
					overlapPaddingMs: args['padding-ms'],
				})
				if (!result.success) {
					throw new Error(result.error ?? 'Combine failed.')
				}
				outputPath = result.outputPath
			},
			{ successText: 'Combine complete' },
		)
		console.log(`Combined video written to ${outputPath}`)
	}
}

export function configureEditVideoCommand(command: Argv) {
	return command
		.option('input', {
			type: 'string',
			describe: 'Input video file',
		})
		.option('transcript', {
			type: 'string',
			describe: 'Transcript JSON path',
		})
		.option('edited', {
			type: 'string',
			describe: 'Edited transcript text path',
		})
		.option('output', {
			type: 'string',
			describe: 'Output video path (defaults to .edited)',
		})
		.option('padding-ms', {
			type: 'number',
			describe: 'Padding around speech boundaries in ms',
		})
}

export async function handleEditVideoCommand(argv: Arguments) {
	const options = createDefaultCliUxOptions()
	await createEditVideoHandler(options)(argv)
}

export function configureCombineVideosCommand(command: Argv) {
	return command
		.option('video1', {
			type: 'string',
			describe: 'First video path',
		})
		.option('transcript1', {
			type: 'string',
			describe: 'Transcript JSON for first video',
		})
		.option('edited1', {
			type: 'string',
			describe: 'Edited transcript text for first video',
		})
		.option('video2', {
			type: 'string',
			describe: 'Second video path',
		})
		.option('transcript2', {
			type: 'string',
			describe: 'Transcript JSON for second video',
		})
		.option('edited2', {
			type: 'string',
			describe: 'Edited transcript text for second video',
		})
		.option('output', {
			type: 'string',
			describe: 'Output video path',
		})
		.option('padding-ms', {
			type: 'number',
			describe: 'Padding around speech boundaries in ms',
		})
}

export async function handleCombineVideosCommand(argv: Arguments) {
	const options = createDefaultCliUxOptions()
	await createCombineVideosHandler(options)(argv)
}

function createDefaultCliUxOptions(): CliUxOptions {
	const interactive = isInteractive()
	if (!interactive) {
		return { interactive }
	}
	const prompter = createInquirerPrompter()
	return { interactive, pathPicker: createPathPicker(prompter) }
}

export async function runEditsCli(rawArgs = hideBin(process.argv)) {
	const interactive = isInteractive()
	const prompter = interactive ? createInquirerPrompter() : null
	const pathPicker = prompter ? createPathPicker(prompter) : undefined
	let args = rawArgs

	if (interactive && args.length === 0 && prompter) {
		const selection = await promptForEditsCommand(prompter)
		if (!selection) {
			return
		}
		args = selection
	}

	const handlerOptions: CliUxOptions = { interactive, pathPicker }
	const parser = yargs(args)
		.scriptName('video-edits')
		.command(
			'edit-video',
			'Edit a single video using transcript text edits',
			configureEditVideoCommand as CommandBuilder,
			createEditVideoHandler(handlerOptions),
		)
		.command(
			'combine-videos',
			'Combine two videos with speech-aligned padding',
			configureCombineVideosCommand as CommandBuilder,
			createCombineVideosHandler(handlerOptions),
		)
		.demandCommand(1)
		.strict()
		.help()

	await parser.parseAsync()
}

if (import.meta.main) {
	runEditsCli().catch((error) => {
		if (error instanceof PromptCancelled) {
			console.log('[info] Cancelled.')
			return
		}
		console.error(
			`[error] ${error instanceof Error ? error.message : String(error)}`,
		)
		process.exit(1)
	})
}

async function promptForEditsCommand(
	prompter: Prompter,
): Promise<string[] | null> {
	const selection = await prompter.search('Choose a command (type to filter)', [
		{
			name: 'Edit a single video using transcript text edits',
			value: 'edit-video',
			description: 'edit-video --input <file> --transcript <json> --edited <txt>',
			keywords: ['transcript', 'cuts', 'remove', 'trim'],
		},
		{
			name: 'Combine two videos with speech-aligned padding',
			value: 'combine-videos',
			description: 'combine-videos --video1 <file> --video2 <file>',
			keywords: ['merge', 'join', 'splice', 'padding'],
		},
		{
			name: 'Show help',
			value: 'help',
			keywords: ['usage', '--help'],
		},
		{ name: 'Exit', value: 'exit', keywords: ['quit', 'cancel'] },
	])
	if (selection === 'exit') {
		return null
	}
	if (selection === 'help') {
		return ['--help']
	}
	return [selection]
}
