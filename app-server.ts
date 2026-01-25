import './app/config/init-env.ts'

import getPort from 'get-port'
import { getEnv } from './app/config/env.ts'
import { createAppRouter } from './app/router.tsx'
import { createBundlingRoutes } from './server/bundling.ts'

type AppServerOptions = {
	host?: string
	port?: number
}

const LOCALHOST_ALIASES = new Set(['127.0.0.1', '::1', 'localhost'])

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
		`  o: open ${url} in browser`,
		'  r: restart server',
		'  q: quit server',
		'  h: show shortcuts',
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

function setupShortcutHandling(options: {
	getUrl: () => string
	restart: () => void
	stop: () => void
}) {
	if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
		return () => {}
	}

	const stdin = process.stdin
	const handleKey = (key: string) => {
		if (key === '\u0003') {
			options.stop()
			return
		}
		const lower = key.toLowerCase()
		if (lower === 'o') {
			openBrowser(options.getUrl())
			return
		}
		if (lower === 'r') {
			options.restart()
			return
		}
		if (lower === 'q') {
			options.stop()
			return
		}
		if (lower === 'h' || lower === '?') {
			logShortcuts(options.getUrl())
		}
	}

	const onData = (chunk: Buffer | string) => {
		const input = chunk.toString()
		for (const key of input) {
			handleKey(key)
		}
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
	const router = createAppRouter(import.meta.dirname)
	return Bun.serve({
		port,
		hostname,
		idleTimeout: 30,
		routes: createBundlingRoutes(import.meta.dirname),
		async fetch(request) {
			try {
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
	const env = getEnv()
	const host = options.host ?? env.HOST
	const desiredPort = options.port ?? env.PORT
	const port = await getServerPort(env.NODE_ENV, desiredPort)
	let server = startServer(port, host)
	const getUrl = () => formatServerUrl(server.hostname, server.port)
	let cleanupInput = () => {}
	const stopServer = () => {
		console.log('[app] stopping server...')
		cleanupInput()
		server.stop()
		process.exit(0)
	}
	const restartServer = () => {
		console.log('[app] restarting server...')
		server.stop()
		server = startServer(port, host)
		console.log(`[app] running at ${getUrl()}`)
	}
	cleanupInput = setupShortcutHandling({
		getUrl,
		restart: restartServer,
		stop: stopServer,
	})
	const url = getUrl()

	console.log(`[app] running at ${url}`)
	logShortcuts(url)

	return { server, url }
}

if (import.meta.main) {
	await startAppServer()
}
