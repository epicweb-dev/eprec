import path from 'node:path'
import '../app/config/init-env.ts'

import getPort from 'get-port'
import { getEnv } from '../app/config/env.ts'
import { createAppRouter } from '../app/router.tsx'
import { handleTrimRequest } from '../app/trim-api.ts'
import { handleVideoRequest } from '../app/video-api.ts'
import { createBundlingRoutes } from '../server/bundling.ts'
import { handleProcessingQueueRequest } from '../server/processing-queue.ts'

type AppServerOptions = {
	host?: string
	port?: number
	videoPath?: string
}

const LOCALHOST_ALIASES = new Set(['127.0.0.1', '::1', 'localhost'])
const COLOR_ENABLED =
	process.env.FORCE_COLOR === '1' ||
	(Boolean(process.stdout.isTTY) && !process.env.NO_COLOR)
const SHORTCUT_COLORS: Record<string, string> = {
	o: '\u001b[36m',
	r: '\u001b[33m',
	q: '\u001b[31m',
	h: '\u001b[35m',
}
const ANSI_RESET = '\u001b[0m'
const APP_ROOT = path.resolve(import.meta.dirname, '..')

type ShortcutActions = {
	open: () => void
	restart: () => void
	stop: () => void
	help: () => void
	spacing: () => void
}

function colorizeShortcut(key: string) {
	if (!COLOR_ENABLED) {
		return key
	}
	const color = SHORTCUT_COLORS[key.toLowerCase()]
	return color ? `${color}${key}${ANSI_RESET}` : key
}

function formatHostnameForDisplay(hostname: string) {
	if (LOCALHOST_ALIASES.has(hostname)) {
		return 'localhost'
	}
	if (hostname.includes(':')) {
		return `[${hostname}]`
	}
	return hostname
}

function formatServerUrl(hostname: string, port: number) {
	return `http://${formatHostnameForDisplay(hostname)}:${port}`
}

function getShortcutLines(url: string) {
	return [
		'[app] shortcuts:',
		`  ${colorizeShortcut('o')}: open ${url} in browser`,
		`  ${colorizeShortcut('r')}: restart server`,
		`  ${colorizeShortcut('q')}: quit server`,
		`  ${colorizeShortcut('h')}: show shortcuts`,
		`  ${colorizeShortcut('enter')}: add log spacing`,
	]
}

function logShortcuts(url: string) {
	for (const line of getShortcutLines(url)) {
		console.log(line)
	}
}

function openBrowser(url: string) {
	const platform = process.platform
	const command =
		platform === 'darwin'
			? ['open', url]
			: platform === 'win32'
				? ['cmd', '/c', 'start', '', url]
				: ['xdg-open', url]
	try {
		const subprocess = Bun.spawn({
			cmd: command,
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore',
		})
		void subprocess.exited.catch((error) => {
			console.warn(
				`[app] failed to open browser: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		})
	} catch (error) {
		console.warn(
			`[app] failed to open browser: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}

export function createShortcutInputHandler(actions: ShortcutActions) {
	let lastKey: string | null = null

	const handleKey = (key: string) => {
		if (key === '\u0003') {
			actions.stop()
			return
		}
		if (key === '\r' || key === '\n') {
			actions.spacing()
			return
		}
		const lower = key.toLowerCase()
		if (lower === 'o') {
			actions.open()
			return
		}
		if (lower === 'r') {
			actions.restart()
			return
		}
		if (lower === 'q') {
			actions.stop()
			return
		}
		if (lower === 'h' || lower === '?') {
			actions.help()
		}
	}

	return {
		handleInput: (input: string) => {
			for (const key of input) {
				if (key === '\n' && lastKey === '\r') {
					lastKey = key
					continue
				}
				handleKey(key)
				lastKey = key
			}
		},
	}
}

function setupShortcutHandling(options: {
	getUrl: () => string
	restart: () => void
	stop: () => void
}) {
	if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
		return () => {}
	}

	const stdin = process.stdin
	const shortcutHandler = createShortcutInputHandler({
		open: () => openBrowser(options.getUrl()),
		restart: options.restart,
		stop: options.stop,
		help: () => logShortcuts(options.getUrl()),
		spacing: () => console.log(''),
	})

	const onData = (chunk: Buffer | string) => {
		shortcutHandler.handleInput(chunk.toString())
	}

	stdin.setRawMode(true)
	stdin.resume()
	stdin.on('data', onData)

	return () => {
		stdin.off('data', onData)
		if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
			stdin.setRawMode(false)
		}
		stdin.pause()
	}
}

function startServer(port: number, hostname: string) {
	const router = createAppRouter(APP_ROOT)
	return Bun.serve({
		port,
		hostname,
		idleTimeout: 30,
		routes: createBundlingRoutes(APP_ROOT),
		async fetch(request) {
			try {
				const url = new URL(request.url)
				if (url.pathname === '/api/video') {
					return await handleVideoRequest(request)
				}
				if (url.pathname === '/api/trim') {
					return await handleTrimRequest(request)
				}
				if (url.pathname.startsWith('/api/processing-queue')) {
					return await handleProcessingQueueRequest(request)
				}
				return await router.fetch(request)
			} catch (error) {
				console.error(error)
				return new Response('Internal Server Error', { status: 500 })
			}
		},
	})
}

async function getServerPort(nodeEnv: string, desiredPort: number) {
	if (nodeEnv === 'production') {
		return desiredPort
	}
	const port = await getPort({ port: desiredPort })
	if (port !== desiredPort) {
		console.warn(
			`⚠️  Port ${desiredPort} was taken, using port ${port} instead`,
		)
	}
	return port
}

export async function startAppServer(options: AppServerOptions = {}) {
	if (options.videoPath) {
		process.env.EPREC_APP_VIDEO_PATH = options.videoPath.trim()
	}
	const env = getEnv()
	const host = options.host ?? env.HOST ?? 'localhost'
	const desiredPort = options.port ?? env.PORT
	const port = await getServerPort(env.NODE_ENV, desiredPort)
	let server = startServer(port, host)
	const getUrl = () => {
		const serverHostname = server.hostname ?? host
		const serverPort = server.port ?? port
		return formatServerUrl(serverHostname, serverPort)
	}
	let cleanupInput = () => {}
	let isRestarting = false
	const stopServer = () => {
		console.log('[app] stopping server...')
		cleanupInput()
		server.stop()
		process.exit(0)
	}
	const restartServer = async () => {
		if (isRestarting) {
			return
		}
		isRestarting = true
		try {
			console.log('[app] restarting server...')
			await server.stop()
			server = startServer(port, host)
			console.log(`[app] running at ${getUrl()}`)
		} finally {
			isRestarting = false
		}
	}
	cleanupInput = setupShortcutHandling({
		getUrl,
		restart: restartServer,
		stop: stopServer,
	})
	const url = getUrl()

	console.log(`[app] running at ${url}`)
	logShortcuts(url)

	return {
		get server() {
			return server
		},
		url,
		stop: () => {
			cleanupInput()
			server.stop()
		},
	}
}

if (import.meta.main) {
	await startAppServer()
}
