import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { downloadWhisperModelFile } from './whispercpp-transcribe'

async function createTempDir() {
	const dir = await mkdtemp(path.join(tmpdir(), 'whisper-model-'))
	return {
		path: dir,
		async [Symbol.asyncDispose]() {
			await rm(dir, { recursive: true, force: true })
		},
	}
}

test('downloadWhisperModelFile retries rate-limited model downloads', async () => {
	await using tempDir = await createTempDir()
	const modelPath = path.join(tempDir.path, 'model.bin')
	const delays: number[] = []
	let calls = 0
	const fetchModel = async () => {
		calls++
		if (calls === 1) {
			return new Response('rate limited', {
				status: 429,
				statusText: 'Too Many Requests',
				headers: { 'retry-after': '1' },
			})
		}
		return new Response('model bytes')
	}

	await downloadWhisperModelFile(modelPath, {
		attemptCount: 2,
		fetch: fetchModel,
		sleep: async (delayMs) => {
			delays.push(delayMs)
		},
	})

	expect(calls).toBe(2)
	expect(delays).toEqual([1000])
	expect(await Bun.file(modelPath).text()).toBe('model bytes')
})

test('downloadWhisperModelFile retries interrupted model downloads', async () => {
	await using tempDir = await createTempDir()
	const modelPath = path.join(tempDir.path, 'model.bin')
	const delays: number[] = []
	let calls = 0
	const fetchModel = async () => {
		calls++
		if (calls === 1) {
			const response = new Response('partial model bytes')
			response.arrayBuffer = async () => {
				throw new TypeError('body interrupted')
			}
			return response
		}
		return new Response('model bytes')
	}

	await downloadWhisperModelFile(modelPath, {
		attemptCount: 2,
		fetch: fetchModel,
		sleep: async (delayMs) => {
			delays.push(delayMs)
		},
	})

	expect(calls).toBe(2)
	expect(delays).toEqual([5000])
	expect(await Bun.file(modelPath).text()).toBe('model bytes')
})

test('downloadWhisperModelFile does not retry permanent download failures', async () => {
	await using tempDir = await createTempDir()
	const modelPath = path.join(tempDir.path, 'model.bin')
	let calls = 0
	const fetchModel = async () => {
		calls++
		return new Response('missing', {
			status: 404,
			statusText: 'Not Found',
		})
	}

	await expect(
		downloadWhisperModelFile(modelPath, {
			attemptCount: 3,
			fetch: fetchModel,
			sleep: async () => {},
		}),
	).rejects.toThrow('404 Not Found')

	expect(calls).toBe(1)
	expect(await Bun.file(modelPath).exists()).toBe(false)
})
