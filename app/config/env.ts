type AppEnv = {
	NODE_ENV: 'development' | 'production' | 'test'
	PORT: number
	HOST: string
}

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '127.0.0.1'

function parseNodeEnv(value: string | undefined): AppEnv['NODE_ENV'] {
	if (value === 'production' || value === 'test') {
		return value
	}
	return 'development'
}

function parsePort(value: string | undefined): number {
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_PORT
	}
	return Math.floor(parsed)
}

export function getEnv(): AppEnv {
	return {
		NODE_ENV: parseNodeEnv(process.env.NODE_ENV),
		PORT: parsePort(process.env.PORT),
		HOST: process.env.HOST?.trim() || DEFAULT_HOST,
	}
}
