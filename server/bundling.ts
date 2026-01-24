import path from 'node:path'

type PackageJson = {
	exports?: Record<string, { default?: string; types?: string } | string>
	module?: string
	main?: string
}

async function resolvePackageExport(
	specifier: string,
	rootDir: string,
): Promise<string | null> {
	const parts = specifier.split('/')
	let packageName: string
	let subpathParts: string[]

	if (specifier.startsWith('@')) {
		if (parts.length < 2) return null
		packageName = `${parts[0]}/${parts[1]}`
		subpathParts = parts.slice(2)
	} else {
		if (parts.length === 0 || !parts[0]) return null
		packageName = parts[0]
		subpathParts = parts.slice(1)
	}

	const subpath = subpathParts.length > 0 ? `./${subpathParts.join('/')}` : '.'
	const packageDir = path.join(rootDir, 'node_modules', packageName)
	const packageJsonPath = path.join(packageDir, 'package.json')
	const packageJsonFile = Bun.file(packageJsonPath)

	if (!(await packageJsonFile.exists())) return null

	const packageJson = JSON.parse(
		await packageJsonFile.text(),
	) as PackageJson

	if (!packageJson.exports) {
		const entryFile = packageJson.module || packageJson.main
		if (entryFile) {
			const entryPath = path.join(packageDir, entryFile)
			if (await Bun.file(entryPath).exists()) return entryPath
		}
		const indexPath = path.join(packageDir, 'index.js')
		return (await Bun.file(indexPath).exists()) ? indexPath : null
	}

	const exportEntry = packageJson.exports[subpath]
	if (!exportEntry) return null

	const exportPath =
		typeof exportEntry === 'string'
			? exportEntry
			: exportEntry.default || exportEntry.types

	if (!exportPath) return null

	const resolvedPath = path.join(packageDir, exportPath)
	return (await Bun.file(resolvedPath).exists()) ? resolvedPath : null
}

const BUNDLING_CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'Accept, Content-Type',
} as const

export function createBundlingRoutes(rootDir: string) {
	const clientDir = path.resolve(rootDir, 'app', 'client')

	return {
		'/app/client/*': async (request: Request) => {
			if (request.method === 'OPTIONS') {
				return new Response(null, {
					status: 204,
					headers: {
						...BUNDLING_CORS_HEADERS,
						'Access-Control-Max-Age': '86400',
					},
				})
			}

			const url = new URL(request.url)
			const reqPath = path.posix.normalize(url.pathname.replace(/^\/+/, ''))
			const resolved = path.resolve(rootDir, reqPath)

			if (!resolved.startsWith(clientDir + path.sep)) {
				return new Response('Forbidden', {
					status: 403,
					headers: BUNDLING_CORS_HEADERS,
				})
			}

			if (!resolved.endsWith('.ts') && !resolved.endsWith('.tsx')) {
				return new Response('Not Found', {
					status: 404,
					headers: BUNDLING_CORS_HEADERS,
				})
			}

			const entryFile = Bun.file(resolved)
			if (!(await entryFile.exists())) {
				return new Response('Not Found', {
					status: 404,
					headers: BUNDLING_CORS_HEADERS,
				})
			}

		const buildResult = await Bun.build({
			entrypoints: [resolved],
			target: 'browser',
			minify: Bun.env.NODE_ENV === 'production',
			splitting: false,
			format: 'esm',
			sourcemap: Bun.env.NODE_ENV === 'production' ? 'none' : 'inline',
			jsx: { importSource: 'remix/component' },
		})

		if (!buildResult.success) {
			const errorMessage = buildResult.logs
				.map((log) => log.message)
				.join('\n')
			return new Response(errorMessage || 'Build failed', {
				status: 500,
				headers: {
					'Content-Type': 'text/plain',
					...BUNDLING_CORS_HEADERS,
				},
			})
		}

		const output = buildResult.outputs[0]
		return new Response(output, {
			headers: {
				'Content-Type': 'application/javascript',
				...BUNDLING_CORS_HEADERS,
			},
		})
		},

		'/node_modules/*': async (request: Request) => {
			if (request.method === 'OPTIONS') {
				return new Response(null, {
					status: 204,
					headers: {
						...BUNDLING_CORS_HEADERS,
						'Access-Control-Max-Age': '86400',
					},
				})
			}

			const url = new URL(request.url)
			const specifier = url.pathname.replace('/node_modules/', '')
			const filepath = await resolvePackageExport(specifier, rootDir)

			if (!filepath) {
				return new Response('Package not found', {
					status: 404,
					headers: BUNDLING_CORS_HEADERS,
				})
			}

		const buildResult = await Bun.build({
			entrypoints: [filepath],
			target: 'browser',
			minify: Bun.env.NODE_ENV === 'production',
			splitting: false,
			format: 'esm',
			sourcemap: Bun.env.NODE_ENV === 'production' ? 'none' : 'inline',
		})

		if (!buildResult.success) {
			const errorMessage = buildResult.logs
				.map((log) => log.message)
				.join('\n')
			return new Response(errorMessage || 'Build failed', {
				status: 500,
				headers: {
					'Content-Type': 'text/plain',
					...BUNDLING_CORS_HEADERS,
				},
			})
		}

		const output = buildResult.outputs[0]
		return new Response(output, {
			headers: {
				'Content-Type': 'application/javascript',
				'Cache-Control':
					Bun.env.NODE_ENV === 'production'
						? 'public, max-age=31536000, immutable'
						: 'no-cache',
				...BUNDLING_CORS_HEADERS,
			},
		})
		},
	}
}
