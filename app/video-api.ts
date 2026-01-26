import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VIDEO_ROUTE = '/api/video'

function isLocalhostOrigin(origin: string | null): boolean {
	if (!origin) return false
	try {
		const url = new URL(origin)
		const hostname = url.hostname.toLowerCase()
		return (
			hostname === 'localhost' ||
			hostname === '127.0.0.1' ||
			hostname === '[::1]'
		)
	} catch {
		return false
	}
}

function getVideoCorsHeaders(origin: string | null) {
	if (!isLocalhostOrigin(origin)) {
		return {}
	}
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
		'Access-Control-Allow-Headers': 'Accept, Content-Type, Range',
	}
}

type ByteRange = { start: number; end: number }

function expandHomePath(value: string) {
	if (!value.startsWith('~/') && !value.startsWith('~\\')) {
		return value
	}
	const home = process.env.HOME?.trim()
	if (!home) return value
	return path.join(home, value.slice(2))
}

function resolveVideoPath(rawPath: string): string | null {
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

function parseRangeHeader(
	header: string | null,
	size: number,
): ByteRange | null {
	if (!header) return null
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (!match) return null
	const startRaw = match[1]
	const endRaw = match[2]
	const start = startRaw ? Number(startRaw) : null
	const end = endRaw ? Number(endRaw) : null
	if (start === null && end === null) return null
	if (start !== null && (!Number.isFinite(start) || start < 0)) return null
	if (end !== null && (!Number.isFinite(end) || end < 0)) return null

	if (start === null) {
		const suffix = end ?? 0
		if (suffix <= 0) return null
		const rangeStart = Math.max(size - suffix, 0)
		return { start: rangeStart, end: size - 1 }
	}

	const rangeEnd = end === null || end >= size ? Math.max(size - 1, 0) : end
	if (start > rangeEnd) return null
	return { start, end: rangeEnd }
}

function buildVideoHeaders(
	contentType: string,
	length: number,
	origin: string | null,
) {
	return {
		'Content-Type': contentType,
		'Content-Length': String(length),
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'no-cache',
		...getVideoCorsHeaders(origin),
	}
}

export async function handleVideoRequest(request: Request): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname !== VIDEO_ROUTE) {
		return new Response('Not Found', { status: 404 })
	}

	const origin = request.headers.get('origin')
	const corsHeaders = getVideoCorsHeaders(origin)

	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				...corsHeaders,
				'Access-Control-Max-Age': '86400',
			},
		})
	}

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method Not Allowed', {
			status: 405,
			headers: corsHeaders,
		})
	}

	const rawPath = url.searchParams.get('path')
	const filePath = rawPath ? resolveVideoPath(rawPath) : null
	if (!filePath) {
		return new Response('Missing or invalid path query.', {
			status: 400,
			headers: corsHeaders,
		})
	}

	const file = Bun.file(filePath)
	if (!(await file.exists())) {
		return new Response('Video file not found.', {
			status: 404,
			headers: corsHeaders,
		})
	}

	const contentType = file.type || 'application/octet-stream'
	const size = file.size
	const rangeHeader = request.headers.get('range')
	if (rangeHeader) {
		const range = parseRangeHeader(rangeHeader, size)
		if (!range) {
			return new Response(null, {
				status: 416,
				headers: {
					'Content-Range': `bytes */${size}`,
					...corsHeaders,
				},
			})
		}
		const chunk = file.slice(range.start, range.end + 1)
		const length = range.end - range.start + 1
		return new Response(request.method === 'HEAD' ? null : chunk, {
			status: 206,
			headers: {
				'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
				...buildVideoHeaders(contentType, length, origin),
			},
		})
	}

	return new Response(request.method === 'HEAD' ? null : file, {
		headers: buildVideoHeaders(contentType, size, origin),
	})
}
