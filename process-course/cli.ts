import path from 'node:path'
import yargs from 'yargs/yargs'
import { hideBin } from 'yargs/helpers'
import type { Argv, Arguments } from 'yargs'
import { getDefaultWhisperModelPath } from '../src/whispercpp-transcribe'
import { DEFAULT_MIN_CHAPTER_SECONDS, TRANSCRIPTION_PHRASES } from './config'
import { normalizeSkipPhrases } from './utils/transcript'
import { parseChapterSelection } from './utils/chapter-selection'
import type { ChapterSelection } from './types'

export const VIDEO_EXTENSIONS = [
	'.mp4',
	'.mkv',
	'.avi',
	'.mov',
	'.webm',
	'.flv',
	'.m4v',
]

export interface CliArgs {
	inputPaths: string[]
	outputDir: string | null
	minChapterDurationSeconds: number
	dryRun: boolean
	keepIntermediates: boolean
	writeLogs: boolean
	enableTranscription: boolean
	whisperModelPath: string
	whisperLanguage: string
	whisperBinaryPath: string | undefined
	whisperSkipPhrases: string[]
	chapterSelection: ChapterSelection | null
	shouldExit: boolean
}

export function configureProcessCommand(
	command: Argv,
	defaultWhisperModelPath = getDefaultWhisperModelPath(),
) {
	return command
		.positional('input', {
			type: 'string',
			array: true,
			describe: 'Input video file(s)',
		})
		.option('output-dir', {
			type: 'string',
			alias: 'o',
			describe:
				'Output directory (optional - if not specified, creates directory next to each input file)',
		})
		.option('min-chapter-seconds', {
			type: 'number',
			alias: 'm',
			describe: 'Skip chapters shorter than this duration in seconds',
			default: DEFAULT_MIN_CHAPTER_SECONDS,
		})
		.option('dry-run', {
			type: 'boolean',
			alias: 'd',
			describe: 'Skip writing output files and running ffmpeg',
			default: false,
		})
		.option('keep-intermediates', {
			type: 'boolean',
			alias: 'k',
			describe: 'Keep intermediate files for debugging',
			default: false,
		})
		.option('write-logs', {
			type: 'boolean',
			alias: 'l',
			describe: 'Write log files when skipping/fallbacks happen',
			default: false,
		})
		.option('enable-transcription', {
			type: 'boolean',
			describe: 'Enable whisper.cpp transcription skip checks',
			default: true,
		})
		.option('whisper-model-path', {
			type: 'string',
			describe: 'Path to whisper.cpp model file',
			default: defaultWhisperModelPath,
		})
		.option('whisper-language', {
			type: 'string',
			describe: 'Language passed to whisper.cpp',
			default: 'en',
		})
		.option('whisper-binary-path', {
			type: 'string',
			describe: 'Path to whisper.cpp CLI (whisper-cli)',
		})
		.option('whisper-skip-phrase', {
			type: 'string',
			array: true,
			describe: 'Phrase to skip chapters when found in transcript (repeatable)',
			default: TRANSCRIPTION_PHRASES,
		})
		.option('chapter', {
			type: 'string',
			array: true,
			alias: 'c',
			describe: 'Only process selected chapters (e.g. 4, 4-6, 4,6,9-12, 4-*)',
		})
}

export function normalizeProcessArgs(
	argv: Arguments,
	defaultWhisperModelPath = getDefaultWhisperModelPath(),
): CliArgs {
	let inputPaths = Array.isArray(argv.input)
		? argv.input.filter((p): p is string => typeof p === 'string')
		: typeof argv.input === 'string'
			? [argv.input]
			: []

	// If output-dir is not explicitly set, check if the last positional arg
	// doesn't look like a video file (no video extension). If so, treat it as the output directory
	let outputDir =
		typeof argv['output-dir'] === 'string' &&
		argv['output-dir'].trim().length > 0
			? argv['output-dir']
			: null

	if (!outputDir && inputPaths.length > 0) {
		const outputCandidate = inputPaths.at(-1)
		if (outputCandidate !== undefined) {
			const hasVideoExtension = VIDEO_EXTENSIONS.some((ext) =>
				outputCandidate.toLowerCase().endsWith(ext),
			)

			if (!hasVideoExtension) {
				// Last argument is likely the output directory
				outputDir = outputCandidate
				inputPaths = inputPaths.slice(0, -1) // Remove the last argument from inputs
			}
		}
	}

	if (inputPaths.length === 0) {
		throw new Error('At least one input file is required.')
	}

	const minChapterDurationSeconds = Number(argv['min-chapter-seconds'])
	if (
		!Number.isFinite(minChapterDurationSeconds) ||
		minChapterDurationSeconds < 0
	) {
		throw new Error('min-chapter-seconds must be a non-negative number.')
	}

	return {
		inputPaths,
		outputDir,
		minChapterDurationSeconds,
		dryRun: Boolean(argv['dry-run']),
		keepIntermediates: Boolean(argv['keep-intermediates']),
		writeLogs: Boolean(argv['write-logs']),
		enableTranscription: Boolean(argv['enable-transcription']),
		whisperModelPath:
			typeof argv['whisper-model-path'] === 'string' &&
			argv['whisper-model-path'].trim().length > 0
				? argv['whisper-model-path']
				: defaultWhisperModelPath,
		whisperLanguage:
			typeof argv['whisper-language'] === 'string' &&
			argv['whisper-language'].trim().length > 0
				? argv['whisper-language'].trim()
				: 'en',
		whisperBinaryPath:
			typeof argv['whisper-binary-path'] === 'string' &&
			argv['whisper-binary-path'].trim().length > 0
				? argv['whisper-binary-path'].trim()
				: undefined,
		whisperSkipPhrases: normalizeSkipPhrases(argv['whisper-skip-phrase']),
		chapterSelection:
			argv.chapter === undefined ? null : parseChapterSelection(argv.chapter),
		shouldExit: false,
	} as CliArgs
}

export function parseCliArgs(rawArgs = hideBin(process.argv)): CliArgs {
	const defaultWhisperModelPath = getDefaultWhisperModelPath()
	const parser = yargs(rawArgs)
		.scriptName('process-course-video')
		.usage(
			"Usage: $0 <input.mp4|input.mkv> [input2.mp4 ...] [output-dir] [--output-dir <dir>] [--min-chapter-seconds <number>] [--dry-run] [--keep-intermediates] [--write-logs] [--enable-transcription]\n  If the last positional argument doesn't have a video extension, it's treated as the output directory.",
		)
		.command(
			'$0 <input...>',
			'Process chapters into separate files',
			(command: Argv) =>
				configureProcessCommand(command, defaultWhisperModelPath),
		)
		.check((args: Arguments) => {
			const minChapterSeconds = args['min-chapter-seconds']
			if (minChapterSeconds !== undefined) {
				if (
					typeof minChapterSeconds !== 'number' ||
					!Number.isFinite(minChapterSeconds) ||
					minChapterSeconds < 0
				) {
					throw new Error('min-chapter-seconds must be a non-negative number.')
				}
			}
			return true
		})
		.strict()
		.help()

	if (rawArgs.length === 0) {
		parser.showHelp((message) => {
			console.log(message)
		})
		return {
			inputPaths: [],
			outputDir: null,
			minChapterDurationSeconds: DEFAULT_MIN_CHAPTER_SECONDS,
			dryRun: false,
			keepIntermediates: false,
			writeLogs: false,
			enableTranscription: true,
			whisperModelPath: defaultWhisperModelPath,
			whisperLanguage: 'en',
			whisperBinaryPath: undefined,
			whisperSkipPhrases: TRANSCRIPTION_PHRASES,
			chapterSelection: null,
			shouldExit: true,
		}
	}

	const argv = parser.parseSync()
	return normalizeProcessArgs(argv, defaultWhisperModelPath)
}
