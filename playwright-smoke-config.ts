import { defineConfig } from '@playwright/test'

const host = process.env.SMOKE_HOST ?? '127.0.0.1'
const port = Number(process.env.SMOKE_PORT ?? 3000)
const baseURL = `http://${host}:${port}`

export default defineConfig({
	testDir: 'e2e/playwright',
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
		command: 'bun ./app-server.ts',
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
