import './app/config/init-env.ts'

import getPort from 'get-port'
import { getEnv } from './app/config/env.ts'
import { createAppRouter } from './app/router.tsx'
import { createBundlingRoutes } from './server/bundling.ts'

type AppServerOptions = {
	host?: string
	port?: number
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
		console.warn(`⚠️  Port ${desiredPort} was taken, using port ${port} instead`)
	}
	return port
}

export async function startAppServer(options: AppServerOptions = {}) {
	const env = getEnv()
	const host = options.host ?? env.HOST
	const desiredPort = options.port ?? env.PORT
	const port = await getServerPort(env.NODE_ENV, desiredPort)
	const server = startServer(port, host)
	const url = `http://${server.hostname}:${server.port}`

	console.log(`[app] running at ${url}`)

	return { server, url }
}

if (import.meta.main) {
	await startAppServer()
}
