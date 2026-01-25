import { test, expect } from 'bun:test'
import type { Arguments } from 'yargs'
import {
	resolveEditVideoArgs,
	resolveCombineVideosArgs,
	buildCombinedOutputPath,
} from './cli'
import { buildEditedOutputPath } from './video-editor'
import type { PathPicker } from '../../cli-ux'

function createArgs(values: Record<string, unknown>): Arguments {
	return values as Arguments
}

function createPathPicker(options?: {
	files?: string[]
	outputs?: string[]
	directories?: string[]
}): PathPicker {
	const fileResponses = options?.files ?? []
	const outputResponses = options?.outputs ?? []
	const directoryResponses = options?.directories ?? []
	let fileIndex = 0
	let outputIndex = 0
	let directoryIndex = 0

	return {
		async pickExistingFile() {
			const response = fileResponses[fileIndex]
			fileIndex += 1
			if (!response) {
				throw new Error('Missing file response')
			}
			return response
		},
		async pickExistingDirectory() {
			const response = directoryResponses[directoryIndex]
			directoryIndex += 1
			if (!response) {
				throw new Error('Missing directory response')
			}
			return response
		},
		async pickOutputPath({ defaultPath }) {
			const response = outputResponses[outputIndex] ?? defaultPath
			outputIndex += 1
			if (!response) {
				throw new Error('Missing output response')
			}
			return response
		},
	}
}

test('resolveEditVideoArgs prompts for missing required paths', async () => {
	const args = createArgs({})
	const pathPicker = createPathPicker({
		files: ['input.mp4', 'transcript.json', 'edited.txt'],
	})
	const result = await resolveEditVideoArgs(args, {
		interactive: true,
		pathPicker,
	})

	expect(result).toEqual({
		input: 'input.mp4',
		transcript: 'transcript.json',
		edited: 'edited.txt',
		output: buildEditedOutputPath('input.mp4'),
		'padding-ms': undefined,
	})
})

test('resolveCombineVideosArgs prompts for transcript when edited provided', async () => {
	const args = createArgs({
		video1: 'video1.mp4',
		edited1: 'edited1.txt',
		video2: 'video2.mp4',
		output: 'combined.mp4',
	})
	const pathPicker = createPathPicker({
		files: ['transcript1.json'],
	})
	const result = await resolveCombineVideosArgs(args, {
		interactive: true,
		pathPicker,
	})

	expect(result.transcript1).toBe('transcript1.json')
	expect(result.transcript2).toBeUndefined()
	expect(result.output).toBe('combined.mp4')
})

test('resolveCombineVideosArgs uses default output when missing', async () => {
	const args = createArgs({
		video1: 'video1.mov',
		video2: 'video2.mp4',
	})
	const pathPicker = createPathPicker()
	const result = await resolveCombineVideosArgs(args, {
		interactive: true,
		pathPicker,
	})

	expect(result.output).toBe(
		buildCombinedOutputPath('video1.mov', 'video2.mp4'),
	)
})
