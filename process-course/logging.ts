import { formatCommand } from '../utils'
import { buildChapterLogPath } from './paths'

type LogHook = () => void

let beforeLogHook: LogHook | null = null
let afterLogHook: LogHook | null = null

export function setLogHooks(hooks: {
	beforeLog?: LogHook
	afterLog?: LogHook
}) {
	beforeLogHook = hooks.beforeLog ?? null
	afterLogHook = hooks.afterLog ?? null
}

function withLogHooks(callback: () => void) {
	beforeLogHook?.()
	callback()
	afterLogHook?.()
}

export function logCommand(command: string[]) {
	withLogHooks(() => {
		console.log(`[cmd] ${formatCommand(command)}`)
	})
}

export function logInfo(message: string) {
	withLogHooks(() => {
		console.log(`[info] ${message}`)
	})
}

export function logWarn(message: string) {
	withLogHooks(() => {
		console.warn(`[warn] ${message}`)
	})
}

export async function writeChapterLog(
	tmpDir: string,
	outputPath: string,
	lines: string[],
) {
	const logPath = buildChapterLogPath(tmpDir, outputPath)
	const body = `${lines.join('\n')}\n`
	await Bun.write(logPath, body)
}
