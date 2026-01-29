import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import {
	buildFfmpegArgs,
	computeOutputDuration,
	normalizeTrimRanges,
	type TrimRange,
} from './trim-commands.ts'

const TRIM_ROUTE = '/api/trim'

type TrimRequestPayload = {
	inputPath?: string
	outputPath?: string
	duration?: number
	ranges?: TrimRange[]
}

function expandHomePath(value: string) {
	if (!value.startsWith('~/') && !value.startsWith('~\\')) {
		return value
	}
	const home = process.env.HOME?.trim()
	if (!home) return value
	return path.join(home, value.slice(2))
}

function resolveMediaPath(rawPath: string): string | null {
	const trimmed = rawPath.trim()
	if (!trimmed) return null
	if (trimmed.startsWith('file://')) {
		try {
			return fileURLToPath(trimmed)
		} catch {
			return null
		}
	}
	return path.resolve(expandHomePath(trimmed))
}

function parseRanges(ranges: unknown): TrimRange[] {
	if (!Array.isArray(ranges)) return []
	return ranges
		.map((entry) => {
			if (!entry || typeof entry !== 'object') return null
			const candidate = entry as TrimRange
			if (
				!Number.isFinite(candidate.start) ||
				!Number.isFinite(candidate.end)
			) {
				return null
			}
			return { start: candidate.start, end: candidate.end }
		})
		.filter((range): range is TrimRange => Boolean(range))
}

function parseOutTimeValue(value: string) {
	const parts = value.trim().split(':')
	if (parts.length !== 3) return null
	const [hours, minutes, seconds] = parts
	if (!hours || !minutes || !seconds) return null
	const h = Number.parseFloat(hours)
	const m = Number.parseFloat(minutes)
	const s = Number.parseFloat(seconds)
	if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) {
		return null
	}
	return h * 3600 + m * 60 + s
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max)
}

async function readLines(
	stream: ReadableStream<Uint8Array> | null,
	onLine: (line: string) => void,
) {
	if (!stream) return
	const decoder = new TextDecoderStream()
	const transformed = stream.pipeThrough(
		decoder as unknown as ReadableWritablePair<string, Uint8Array>,
	)
	const reader = transformed.getReader()
	let buffer = ''
	while (true) {
		const { value, done } = await reader.read()
		if (done) break
		buffer += value
		const lines = buffer.split('\n')
		buffer = lines.pop() ?? ''
		for (const line of lines) {
			const trimmed = line.trim()
			if (trimmed) onLine(trimmed)
		}
	}
	const trailing = buffer.trim()
	if (trailing) onLine(trailing)
}

export async function handleTrimRequest(request: Request): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname !== TRIM_ROUTE) {
		return new Response('Not Found', { status: 404 })
	}

	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type',
			},
		})
	}

	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	let payload: TrimRequestPayload
	try {
		payload = (await request.json()) as TrimRequestPayload
	} catch {
		return new Response('Invalid JSON payload.', { status: 400 })
	}

	const inputRaw = payload.inputPath ?? ''
	const outputRaw = payload.outputPath ?? ''
	const duration = Number(payload.duration ?? 0)
	if (!Number.isFinite(duration) || duration <= 0) {
		return new Response('Invalid or missing duration.', { status: 400 })
	}

	const inputPath = resolveMediaPath(inputRaw)
	const outputPath = resolveMediaPath(outputRaw)
	if (!inputPath || !outputPath) {
		return new Response('Input and output paths are required.', {
			status: 400,
		})
	}

	const ranges = normalizeTrimRanges(parseRanges(payload.ranges), duration)
	if (ranges.length === 0) {
		return new Response('No valid trim ranges provided.', { status: 400 })
	}

	const outputDuration = computeOutputDuration(duration, ranges)
	if (outputDuration <= 0) {
		return new Response('Trim ranges remove the full video.', { status: 400 })
	}

	const resolvedInput = path.resolve(inputPath)
	const resolvedOutput = path.resolve(outputPath)
	if (resolvedInput === resolvedOutput) {
		return new Response('Output path must be different from input.', {
			status: 400,
		})
	}

	const inputFile = Bun.file(resolvedInput)
	if (!(await inputFile.exists())) {
		return new Response('Input file not found.', { status: 404 })
	}

	await mkdir(path.dirname(resolvedOutput), { recursive: true })

	const args = buildFfmpegArgs({
		inputPath: resolvedInput,
		outputPath: resolvedOutput,
		ranges,
		withProgress: true,
	})
	if (args.length === 0) {
		return new Response('Unable to build ffmpeg command.', { status: 400 })
	}

	const outputDurationSeconds = outputDuration
	const encoder = new TextEncoder()

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let outTimeSeconds = 0
			const send = (payload: Record<string, unknown>) => {
				try {
					controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
				} catch {
					// stream closed
				}
			}
			const process = Bun.spawn({
				cmd: args,
				stdout: 'pipe',
				stderr: 'pipe',
			})

			request.signal.addEventListener('abort', () => {
				try {
					process.kill()
				} catch {
					// ignore
				}
			})

			const stdoutReader = readLines(process.stdout, (line) => {
				const [key, rawValue] = line.split('=')
				const value = rawValue ?? ''
				if (key === 'out_time_ms') {
					const next = Number.parseFloat(value)
					if (Number.isFinite(next)) outTimeSeconds = next / 1000
				}
				if (key === 'out_time_us') {
					const next = Number.parseFloat(value)
					if (Number.isFinite(next)) outTimeSeconds = next / 1000000
				}
				if (key === 'out_time') {
					const parsed = parseOutTimeValue(value)
					if (parsed !== null) outTimeSeconds = parsed
				}
				if (key === 'progress') {
					const progress =
						outputDurationSeconds > 0
							? clamp(outTimeSeconds / outputDurationSeconds, 0, 1)
							: 0
					send({ type: 'progress', progress })
					if (value === 'end') {
						send({ type: 'progress', progress: 1 })
					}
				}
			})

			const stderrReader = readLines(process.stderr, (line) => {
				send({ type: 'log', message: line })
			})

			Promise.all([stdoutReader, stderrReader, process.exited])
				.then(([, , exitCode]) => {
					send({
						type: 'done',
						success: exitCode === 0,
						exitCode,
					})
				})
				.catch((error) => {
					send({
						type: 'done',
						success: false,
						error: error instanceof Error ? error.message : String(error),
					})
				})
				.finally(() => {
					controller.close()
				})
		},
	})

	return new Response(stream, {
		headers: {
			'Content-Type': 'application/x-ndjson',
			'Cache-Control': 'no-cache',
			'Access-Control-Allow-Origin': '*',
		},
	})
}
