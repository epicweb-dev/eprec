export type TrimRange = {
	start: number
	end: number
}

const DEFAULT_MIN_RANGE = 0.05

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max)
}

function formatSecondsForCommand(value: number) {
	return value.toFixed(3)
}

export function normalizeTrimRanges(
	ranges: TrimRange[],
	duration: number,
	minLength: number = DEFAULT_MIN_RANGE,
) {
	if (!Number.isFinite(duration) || duration <= 0) return []
	const normalized = ranges
		.map((range) => {
			const startRaw = Number.isFinite(range.start) ? range.start : 0
			const endRaw = Number.isFinite(range.end) ? range.end : 0
			const start = clamp(Math.min(startRaw, endRaw), 0, duration)
			const end = clamp(Math.max(startRaw, endRaw), 0, duration)
			if (end - start < minLength) return null
			return { start, end }
		})
		.filter((range): range is TrimRange => Boolean(range))
		.sort((a, b) => a.start - b.start)

	const merged: TrimRange[] = []
	for (const range of normalized) {
		const last = merged[merged.length - 1]
		if (last && range.start <= last.end + minLength) {
			last.end = Math.max(last.end, range.end)
		} else {
			merged.push({ ...range })
		}
	}
	return merged
}

export function computeOutputDuration(
	duration: number,
	ranges: TrimRange[],
	minLength: number = DEFAULT_MIN_RANGE,
) {
	const normalized = normalizeTrimRanges(ranges, duration, minLength)
	const removed = normalized.reduce(
		(total, range) => total + (range.end - range.start),
		0,
	)
	return Math.max(duration - removed, 0)
}

export function buildTrimExpression(ranges: TrimRange[]) {
	if (ranges.length === 0) return ''
	const expressions = ranges.map(
		(range) =>
			`between(t,${formatSecondsForCommand(range.start)},${formatSecondsForCommand(range.end)})`,
	)
	return `not(${expressions.join('+')})`
}

export function buildTrimFilters(ranges: TrimRange[]) {
	const expression = buildTrimExpression(ranges)
	if (!expression) {
		return {
			expression: '',
			videoFilter: '',
			audioFilter: '',
		}
	}
	return {
		expression,
		videoFilter: `select='${expression}',setpts=N/FRAME_RATE/TB`,
		audioFilter: `aselect='${expression}',asetpts=N/SR/TB`,
	}
}

export function buildFfmpegArgs(options: {
	inputPath: string
	outputPath: string
	ranges: TrimRange[]
	withProgress?: boolean
}) {
	const filters = buildTrimFilters(options.ranges)
	if (!filters.expression) return []
	const args = [
		'ffmpeg',
		'-hide_banner',
		'-y',
		'-i',
		options.inputPath,
		'-vf',
		filters.videoFilter,
		'-af',
		filters.audioFilter,
		'-map',
		'0:v',
		'-map',
		'0:a?',
		'-c:v',
		'libx264',
		'-preset',
		'veryfast',
		'-crf',
		'18',
		'-c:a',
		'aac',
		'-b:a',
		'192k',
		'-movflags',
		'+faststart',
	]
	if (options.withProgress) {
		args.push('-progress', 'pipe:1', '-nostats')
	}
	args.push(options.outputPath)
	return args
}

function quoteShellArgument(value: string) {
	const escaped = value.replace(/(["\\$`])/g, '\\$1')
	return `"${escaped}"`
}

export function buildFfmpegCommandPreview(options: {
	inputPath: string
	outputPath: string
	ranges: TrimRange[]
	includeProgress?: boolean
}) {
	const filters = buildTrimFilters(options.ranges)
	if (!filters.expression) return ''
	const lines = [
		'ffmpeg -hide_banner -y \\',
		`  -i ${quoteShellArgument(options.inputPath)} \\`,
		`  -vf ${quoteShellArgument(filters.videoFilter)} \\`,
		`  -af ${quoteShellArgument(filters.audioFilter)} \\`,
		'  -map 0:v -map 0:a? \\',
		'  -c:v libx264 -preset veryfast -crf 18 \\',
		'  -c:a aac -b:a 192k \\',
		'  -movflags +faststart \\',
	]
	if (options.includeProgress) {
		lines.push('  -progress pipe:1 -nostats \\')
	}
	lines.push(`  ${quoteShellArgument(options.outputPath)}`)
	return lines.join('\n')
}
