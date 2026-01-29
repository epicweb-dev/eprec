import { test, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createPathPicker } from './cli-ux'
import type { PromptChoice, Prompter } from './cli-ux'

async function createTempDir() {
	const dir = await mkdtemp(path.join(tmpdir(), 'eprec-'))
	return {
		dir,
		async [Symbol.asyncDispose]() {
			await rm(dir, { recursive: true, force: true })
		},
	}
}

function createPrompterReturningPathString(): Prompter {
	let selectCalls = 0
	return {
		async select<T>(_message: string, choices: PromptChoice<T>[]): Promise<T> {
			selectCalls += 1
			if (selectCalls > 1) {
				throw new Error('select called too many times')
			}
			const fileChoice = findFileChoice(choices)
			if (!fileChoice) {
				throw new Error('Missing file choice')
			}
			// Find the choice that matches the file path and return its value
			const matchingChoice = choices.find(
				(c) =>
					c.value &&
					typeof c.value === 'object' &&
					'path' in c.value &&
					c.value.path === fileChoice.path,
			)
			if (!matchingChoice) {
				throw new Error('Missing matching choice')
			}
			return matchingChoice.value as T
		},
		async search() {
			throw new Error('search not expected')
		},
		async input() {
			throw new Error('input not expected')
		},
		async confirm() {
			throw new Error('confirm not expected')
		},
	}
}

function findFileChoice(
	choices: PromptChoice<unknown>[],
): { path: string } | null {
	for (const choice of choices) {
		const value = choice.value
		if (!value || typeof value !== 'object') {
			continue
		}
		if ('kind' in value && value.kind === 'file' && 'path' in value) {
			return { path: String(value.path) }
		}
	}
	return null
}

test('createPathPicker accepts string selection from prompt', async () => {
	await using tempDir = await createTempDir()
	const videoPath = path.join(tempDir.dir, 'video.mp4')
	await writeFile(videoPath, 'video')

	const pathPicker = createPathPicker(createPrompterReturningPathString())
	const selected = await pathPicker.pickExistingFile({
		message: 'Select input video file',
		startDir: tempDir.dir,
		extensions: ['.mp4'],
	})

	expect(selected).toBe(videoPath)
})
