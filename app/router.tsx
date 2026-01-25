import path from 'node:path'
import { createRouter, type Middleware } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { Layout } from './components/layout.tsx'
import routes from './config/routes.ts'
import { render } from './helpers/render.ts'
import indexHandlers from './routes/index.tsx'

const STATIC_CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'Accept, Content-Type',
} as const

function bunStaticFiles(
	root: string,
	options: { filter?: (pathname: string) => boolean; cacheControl?: string },
): Middleware {
	const absoluteRoot = path.resolve(root)
	return async (context, next) => {
		if (context.method === 'OPTIONS') {
			const relativePath = context.url.pathname.replace(/^\/+/, '')
			if (options.filter && !options.filter(relativePath)) {
				return next()
			}
			const filePath = path.join(absoluteRoot, relativePath)
			if (!filePath.startsWith(absoluteRoot + path.sep)) {
				return next()
			}
			const file = Bun.file(filePath)
			if (!(await file.exists())) {
				return next()
			}
			return new Response(null, {
				status: 204,
				headers: {
					...STATIC_CORS_HEADERS,
					'Access-Control-Max-Age': '86400',
				},
			})
		}

		if (context.method !== 'GET' && context.method !== 'HEAD') {
			return next()
		}
		const relativePath = context.url.pathname.replace(/^\/+/, '')
		if (options.filter && !options.filter(relativePath)) {
			return next()
		}
		const filePath = path.join(absoluteRoot, relativePath)
		if (!filePath.startsWith(absoluteRoot + path.sep)) {
			return next()
		}
		const file = Bun.file(filePath)
		if (!(await file.exists())) {
			return next()
		}
		return new Response(context.method === 'HEAD' ? null : file, {
			headers: {
				'Content-Type': file.type,
				'Content-Length': String(file.size),
				...(options.cacheControl
					? { 'Cache-Control': options.cacheControl }
					: {}),
				...STATIC_CORS_HEADERS,
			},
		})
	}
}

const cacheControl =
	process.env.NODE_ENV === 'production'
		? 'public, max-age=31536000, immutable'
		: 'no-cache'

export function createAppRouter(rootDir: string) {
	const router = createRouter({
		middleware: [
			bunStaticFiles(rootDir, {
				filter: (pathname) => pathname.startsWith('fixtures/'),
				cacheControl,
			}),
			bunStaticFiles(path.join(rootDir, 'public'), { cacheControl }),
			bunStaticFiles(path.join(rootDir, 'app'), {
				filter: (pathname) => pathname.startsWith('assets/'),
				cacheControl,
			}),
		],
		defaultHandler() {
			return render(
				Layout({
					title: 'Not Found',
					entryScript: false,
					children: html`<main class="app-shell">
						<h1 class="app-title">404 - Not Found</h1>
					</main>`,
				}),
				{ status: 404 },
			)
		},
	})

	router.map(routes.index, {
		middleware: indexHandlers.middleware,
		action: indexHandlers.loader,
	})

	return router
}
