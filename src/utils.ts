type RunCommandOptions = {
	allowFailure?: boolean
	logCommand?: (command: string[]) => void
}

export function formatCommand(command: string[]) {
	return command
		.map((part) => (part.includes(' ') ? `"${part}"` : part))
		.join(' ')
}

export async function runCommand(
	command: string[],
	options: RunCommandOptions = {},
) {
	options.logCommand?.(command)
	const proc = Bun.spawn(command, {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])

	if (exitCode !== 0 && !options.allowFailure) {
		throw new Error(
			`Command failed (${exitCode}): ${formatCommand(command)}\n${stderr}`,
		)
	}

	return { stdout, stderr, exitCode }
}

export async function runCommandBinary(
	command: string[],
	options: RunCommandOptions = {},
) {
	options.logCommand?.(command)
	const proc = Bun.spawn(command, {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	])

	if (exitCode !== 0 && !options.allowFailure) {
		throw new Error(
			`Command failed (${exitCode}): ${formatCommand(command)}\n${stderr}`,
		)
	}

	return { stdout: new Uint8Array(stdout), stderr, exitCode }
}

export function formatSeconds(value: number) {
	return `${value.toFixed(2)}s`
}

export function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max)
}

export function toKebabCase(value: string) {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/['".,]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.replace(/-+/g, '-') || 'untitled'
	)
}

export function normalizeFilename(value: string) {
	const numberWords: Record<string, number> = {
		zero: 0,
		one: 1,
		two: 2,
		three: 3,
		four: 4,
		five: 5,
		six: 6,
		seven: 7,
		eight: 8,
		nine: 9,
		ten: 10,
		eleven: 11,
		twelve: 12,
		thirteen: 13,
		fourteen: 14,
		fifteen: 15,
		sixteen: 16,
		seventeen: 17,
		eighteen: 18,
		nineteen: 19,
		twenty: 20,
	}

	const numberWordPattern = new RegExp(
		`\\b(${Object.keys(numberWords).join('|')})\\b`,
		'g',
	)

	return value
		.trim()
		.toLowerCase()
		.replace(/\b(point|dot)\b/g, '.')
		.replace(/\s*\.\s*/g, '.')
		.replace(numberWordPattern, (word) =>
			String(numberWords[word] ?? word).padStart(2, '0'),
		)
}

export async function getMediaDurationSeconds(
	filePath: string,
): Promise<number> {
	const result = await runCommand([
		'ffprobe',
		'-v',
		'error',
		'-show_entries',
		'format=duration',
		'-of',
		'default=noprint_wrappers=1:nokey=1',
		filePath,
	])
	const duration = Number.parseFloat(result.stdout.trim())
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new Error(`Invalid duration for ${filePath}: ${result.stdout}`)
	}
	return duration
}
