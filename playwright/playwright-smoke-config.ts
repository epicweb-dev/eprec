import path from 'node:path'
import { defineConfig } from '@playwright/test'

const rootDir = path.resolve(import.meta.dirname, '..')
const host = process.env.SMOKE_HOST ?? '127.0.0.1'
const port = Number(process.env.SMOKE_PORT ?? 3000)
const baseURL = `http://${host}:${port}`

export default defineConfig({
	testDir: '.',
	testMatch: '**/playwright-smoke.spec.ts',
	timeout: 30_000,
	expect: {
		timeout: 5_000,
	},
	retries: process.env.CI ? 1 : 0,
	use: {
		baseURL,
		browserName: 'chromium',
	},
	webServer: {
		command: 'bun ./src/app-server.ts',
		cwd: rootDir,
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		env: {
			HOST: host,
			PORT: String(port),
			NODE_ENV: 'production',
		},
	},
})
