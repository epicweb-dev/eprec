import type { Handle } from 'remix/component'
import {
	buildFfmpegCommandPreview,
	computeOutputDuration,
	normalizeTrimRanges,
	type TrimRange,
} from '../trim-commands.ts'

type AppConfig = {
	initialVideoPath?: string
}

declare global {
	interface Window {
		__EPREC_APP__?: AppConfig
	}
}

type TrimRangeWithId = TrimRange & { id: string }

const DEFAULT_TRIM_LENGTH = 2.5
const MIN_TRIM_LENGTH = 0.1
const PLAYHEAD_STEP = 0.1
const KEYBOARD_STEP = 0.1
const SHIFT_STEP = 1
const DEMO_VIDEO_PATH = 'fixtures/e2e-test.mp4'
const WAVEFORM_SAMPLES = 240

function readInitialVideoPath() {
	if (typeof window === 'undefined') return ''
	const raw = window.__EPREC_APP__?.initialVideoPath
	if (typeof raw !== 'string') return ''
	return raw.trim()
}

function buildVideoPreviewUrl(value: string) {
	return `/api/video?path=${encodeURIComponent(value)}`
}

function buildOutputPath(value: string) {
	const trimmed = value.trim()
	if (!trimmed) return ''
	const extensionMatch = trimmed.match(/(\.[^./\\]+)$/)
	if (extensionMatch) {
		return trimmed.replace(/(\.[^./\\]+)$/, '.trimmed$1')
	}
	return `${trimmed}.trimmed.mp4`
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max)
}

function sortRanges(ranges: TrimRangeWithId[]) {
	return ranges.slice().sort((a, b) => a.start - b.start)
}

function formatTimestamp(value: number) {
	const clamped = Math.max(value, 0)
	const totalSeconds = Math.floor(clamped)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	const hundredths = Math.floor((clamped - totalSeconds) * 100)
	return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
}

function parseTimestampInput(value: string) {
	const trimmed = value.trim()
	if (!trimmed) return null
	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		const seconds = Number.parseFloat(trimmed)
		return Number.isFinite(seconds) ? seconds : null
	}
	const parts = trimmed.split(':').map((part) => part.trim())
	if (parts.length !== 2 && parts.length !== 3) return null
	const secondsPart = Number.parseFloat(parts[parts.length - 1] ?? '')
	const minutesPart = Number.parseFloat(parts[parts.length - 2] ?? '')
	const hoursPart =
		parts.length === 3 ? Number.parseFloat(parts[0] ?? '') : 0
	if (
		!Number.isFinite(secondsPart) ||
		!Number.isFinite(minutesPart) ||
		!Number.isFinite(hoursPart)
	) {
		return null
	}
	if (secondsPart < 0 || minutesPart < 0 || hoursPart < 0) return null
	return hoursPart * 3600 + minutesPart * 60 + secondsPart
}

function formatSeconds(value: number) {
	return `${value.toFixed(1)}s`
}

function classNames(...values: Array<string | false | null | undefined>) {
	return values.filter(Boolean).join(' ')
}

export function TrimPoints(handle: Handle) {
	const initialVideoPath = readInitialVideoPath()
	let videoPathInput = initialVideoPath
	let outputPathInput = initialVideoPath ? buildOutputPath(initialVideoPath) : ''
	let pathStatus: 'idle' | 'loading' | 'ready' | 'error' = initialVideoPath
		? 'loading'
		: 'idle'
	let pathError = ''
	let previewUrl = ''
	let previewError = ''
	let previewDuration = 0
	let previewReady = false
	let previewNode: HTMLVideoElement | null = null
	let trackNode: HTMLDivElement | null = null
	let playhead = 0
	let previewPlaying = false
	let timeInputValue = formatTimestamp(playhead)
	let isTimeEditing = false
	let trimRanges: TrimRangeWithId[] = []
	let selectedRangeId: string | null = null
	let rangeCounter = 1
	let activeDrag:
		| { rangeId: string; edge: 'start' | 'end'; pointerId: number }
		| null = null
	let runStatus: 'idle' | 'running' | 'success' | 'error' = 'idle'
	let runProgress = 0
	let runError = ''
	let runLogs: string[] = []
	let runController: AbortController | null = null
	let initialLoadTriggered = false
	let waveformSamples: number[] = []
	let waveformStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
	let waveformError = ''
	let waveformSource = ''
	let waveformNode: HTMLCanvasElement | null = null

	const updateVideoPathInput = (value: string) => {
		videoPathInput = value
		if (pathError) pathError = ''
		if (pathStatus === 'error') pathStatus = 'idle'
		handle.update()
	}

	const updateOutputPathInput = (value: string) => {
		outputPathInput = value
		handle.update()
	}

	const resetPreviewState = () => {
		previewReady = false
		previewError = ''
		previewDuration = 0
	}

	const syncVideoToTime = (
		value: number,
		options: { skipVideo?: boolean; updateInput?: boolean } = {},
	) => {
		const maxDuration = previewDuration > 0 ? previewDuration : value
		const nextTime = clamp(value, 0, Math.max(maxDuration, 0))
		playhead = nextTime
		if (!isTimeEditing || options.updateInput) {
			timeInputValue = formatTimestamp(nextTime)
		}
		if (
			previewNode &&
			previewReady &&
			!options.skipVideo &&
			Math.abs(previewNode.currentTime - nextTime) > 0.02
		) {
			previewNode.currentTime = nextTime
		}
		handle.update()
	}

	const updateTimeInput = (value: string) => {
		timeInputValue = value
		isTimeEditing = true
		handle.update()
	}

	const commitTimeInput = () => {
		const parsed = parseTimestampInput(timeInputValue)
		isTimeEditing = false
		if (parsed === null) {
			timeInputValue = formatTimestamp(playhead)
			handle.update()
			return
		}
		syncVideoToTime(parsed, { updateInput: true })
	}

	const drawWaveform = () => {
		if (!waveformNode) return
		const ctx = waveformNode.getContext('2d')
		if (!ctx) return
		const width = waveformNode.clientWidth
		const height = waveformNode.clientHeight
		if (width <= 0 || height <= 0) return
		const dpr =
			typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
		waveformNode.width = Math.floor(width * dpr)
		waveformNode.height = Math.floor(height * dpr)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.clearRect(0, 0, width, height)
		const color =
			typeof window !== 'undefined'
				? window.getComputedStyle(waveformNode).color
				: '#94a3b8'
		ctx.strokeStyle = color
		ctx.lineWidth = 1
		if (waveformSamples.length === 0) {
			ctx.beginPath()
			ctx.moveTo(0, height / 2)
			ctx.lineTo(width, height / 2)
			ctx.stroke()
			return
		}
		const mid = height / 2
		const step = width / waveformSamples.length
		ctx.beginPath()
		waveformSamples.forEach((sample, index) => {
			const x = index * step
			const amplitude = sample * (mid - 2)
			ctx.moveTo(x, mid - amplitude)
			ctx.lineTo(x, mid + amplitude)
		})
		ctx.stroke()
	}

	const loadWaveform = async (url: string) => {
		if (!url || waveformStatus === 'loading') return
		if (waveformSource === url && waveformStatus === 'ready') return
		waveformSource = url
		waveformStatus = 'loading'
		waveformError = ''
		waveformSamples = []
		drawWaveform()
		handle.update()
		try {
			if (typeof window === 'undefined' || !('AudioContext' in window)) {
				throw new Error('AudioContext unavailable in this browser.')
			}
			const response = await fetch(url, {
				cache: 'no-store',
				signal: handle.signal,
			})
			if (!response.ok) {
				throw new Error(`Waveform load failed (status ${response.status}).`)
			}
			const buffer = await response.arrayBuffer()
			if (handle.signal.aborted) return
			const audioContext = new AudioContext()
			let audioBuffer: AudioBuffer
			try {
				audioBuffer = await audioContext.decodeAudioData(buffer.slice(0))
			} finally {
				void audioContext.close()
			}
			if (audioBuffer.numberOfChannels === 0) {
				throw new Error('No audio track found in the video.')
			}
			const channelCount = audioBuffer.numberOfChannels
			const channels = Array.from({ length: channelCount }, (_, index) =>
				audioBuffer.getChannelData(index),
			)
			const totalSamples = audioBuffer.length
			const sampleCount = Math.max(
				1,
				Math.min(WAVEFORM_SAMPLES, totalSamples),
			)
			const blockSize = Math.max(1, Math.floor(totalSamples / sampleCount))
			const samples = new Array(sampleCount).fill(0)
			let maxValue = 0
			for (let i = 0; i < sampleCount; i++) {
				const start = i * blockSize
				const end =
					i === sampleCount - 1 ? totalSamples : start + blockSize
				let peak = 0
				for (let j = start; j < end; j++) {
					let sum = 0
					for (const channel of channels) {
						sum += Math.abs(channel[j] ?? 0)
					}
					const avg = sum / channelCount
					if (avg > peak) peak = avg
				}
				samples[i] = peak
				if (peak > maxValue) maxValue = peak
			}
			const normalizedSamples =
				maxValue > 0 ? samples.map((sample) => sample / maxValue) : samples
			waveformSamples = normalizedSamples
			waveformStatus = 'ready'
			handle.update()
			drawWaveform()
		} catch (error) {
			if (handle.signal.aborted) return
			waveformStatus = 'error'
			waveformError =
				error instanceof Error
					? error.message
					: 'Unable to render waveform.'
			handle.update()
		}
	}

	const applyPreviewSource = (url: string) => {
		previewUrl = url
		resetPreviewState()
		handle.update()
	}

	const loadVideoFromPath = async (override?: string) => {
		const candidate = (override ?? videoPathInput).trim()
		if (!candidate) {
			pathError = 'Enter a video file path to load.'
			pathStatus = 'error'
			handle.update()
			return
		}
		videoPathInput = candidate
		pathStatus = 'loading'
		pathError = ''
		previewError = ''
		handle.update()
		const preview = buildVideoPreviewUrl(candidate)
		try {
			const response = await fetch(preview, {
				method: 'HEAD',
				cache: 'no-store',
				signal: handle.signal,
			})
			if (!response.ok) {
				const message =
					response.status === 404
						? 'Video file not found. Check the path.'
						: `Unable to load the video (status ${response.status}).`
				throw new Error(message)
			}
			if (handle.signal.aborted) return
			pathStatus = 'ready'
			outputPathInput = buildOutputPath(candidate)
			applyPreviewSource(preview)
			void loadWaveform(preview)
		} catch (error) {
			if (handle.signal.aborted) return
			pathStatus = 'error'
			pathError =
				error instanceof Error ? error.message : 'Unable to load the video.'
			handle.update()
		}
	}

	const loadDemoVideo = () => {
		videoPathInput = DEMO_VIDEO_PATH
		outputPathInput = buildOutputPath(DEMO_VIDEO_PATH)
		void loadVideoFromPath(DEMO_VIDEO_PATH)
	}

	if (initialVideoPath && !initialLoadTriggered) {
		initialLoadTriggered = true
		void loadVideoFromPath(initialVideoPath)
	}

	const setPlayhead = (value: number) => {
		if (!previewReady || previewDuration <= 0) return
		syncVideoToTime(value, { updateInput: true })
	}

	const addTrimRange = () => {
		if (!previewReady || previewDuration <= 0) {
			pathError = 'Load a video before adding trim ranges.'
			pathStatus = 'error'
			handle.update()
			return
		}
		const start = clamp(playhead, 0, previewDuration - MIN_TRIM_LENGTH)
		const end = clamp(
			start + DEFAULT_TRIM_LENGTH,
			start + MIN_TRIM_LENGTH,
			previewDuration,
		)
		const newRange: TrimRangeWithId = {
			id: `trim-${rangeCounter++}`,
			start,
			end,
		}
		trimRanges = sortRanges([...trimRanges, newRange])
		selectedRangeId = newRange.id
		syncVideoToTime(start, { updateInput: true })
	}

	const removeTrimRange = (rangeId: string) => {
		trimRanges = trimRanges.filter((range) => range.id !== rangeId)
		if (selectedRangeId === rangeId) {
			selectedRangeId = trimRanges[0]?.id ?? null
		}
		handle.update()
	}

	const updateTrimRange = (
		rangeId: string,
		patch: Partial<TrimRange>,
		edge?: 'start' | 'end',
	) => {
		trimRanges = sortRanges(
			trimRanges.map((range) => {
				if (range.id !== rangeId) return range
				let nextStart = Number.isFinite(patch.start)
					? patch.start
					: range.start
				let nextEnd = Number.isFinite(patch.end) ? patch.end : range.end
				if (edge === 'start') {
					nextStart = clamp(
						nextStart,
						0,
						Math.max(previewDuration - MIN_TRIM_LENGTH, 0),
					)
					nextEnd = clamp(
						nextEnd,
						nextStart + MIN_TRIM_LENGTH,
						previewDuration,
					)
				} else if (edge === 'end') {
					nextEnd = clamp(nextEnd, MIN_TRIM_LENGTH, previewDuration)
					nextStart = clamp(nextStart, 0, nextEnd - MIN_TRIM_LENGTH)
				} else {
					const minStart = clamp(
						nextStart,
						0,
						Math.max(previewDuration - MIN_TRIM_LENGTH, 0),
					)
					const minEnd = clamp(
						nextEnd,
						minStart + MIN_TRIM_LENGTH,
						previewDuration,
					)
					nextStart = minStart
					nextEnd = minEnd
				}
				return { ...range, start: nextStart, end: nextEnd }
			}),
		)
		selectedRangeId = rangeId
		handle.update()
	}

	const selectRange = (rangeId: string) => {
		selectedRangeId = rangeId
		const range = trimRanges.find((entry) => entry.id === rangeId)
		if (range) {
			syncVideoToTime(range.start, { updateInput: true })
			return
		}
		handle.update()
	}

	const getTimeFromClientX = (clientX: number) => {
		if (!trackNode || previewDuration <= 0) return 0
		const rect = trackNode.getBoundingClientRect()
		const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
		return ratio * previewDuration
	}

	const startDrag = (
		event: PointerEvent,
		rangeId: string,
		edge: 'start' | 'end',
	) => {
		if (!trackNode || previewDuration <= 0) return
		activeDrag = { rangeId, edge, pointerId: event.pointerId }
		const target = event.currentTarget as HTMLElement
		target.setPointerCapture(event.pointerId)
		const nextTime = getTimeFromClientX(event.clientX)
		updateTrimRange(rangeId, { [edge]: nextTime }, edge)
		syncVideoToTime(nextTime, { updateInput: true })
	}

	const moveDrag = (event: PointerEvent) => {
		if (!activeDrag || activeDrag.pointerId !== event.pointerId) return
		const nextTime = getTimeFromClientX(event.clientX)
		updateTrimRange(
			activeDrag.rangeId,
			{ [activeDrag.edge]: nextTime },
			activeDrag.edge,
		)
		syncVideoToTime(nextTime, { updateInput: true })
	}

	const endDrag = (event: PointerEvent) => {
		if (!activeDrag || activeDrag.pointerId !== event.pointerId) return
		activeDrag = null
	}

	const handleRangeKey = (
		event: KeyboardEvent,
		range: TrimRangeWithId,
		edge: 'start' | 'end',
	) => {
		const isForward =
			event.key === 'ArrowUp' || event.key === 'ArrowRight'
		const isBackward =
			event.key === 'ArrowDown' || event.key === 'ArrowLeft'
		if (!isForward && !isBackward) return
		event.preventDefault()
		const step = event.shiftKey ? SHIFT_STEP : KEYBOARD_STEP
		const delta = isForward ? step : -step
		const nextValue = edge === 'start' ? range.start + delta : range.end + delta
		updateTrimRange(
			range.id,
			{
				[edge]: nextValue,
			},
			edge,
		)
		syncVideoToTime(nextValue, { updateInput: true })
	}

	const handleNumberKey = (
		event: KeyboardEvent,
		range: TrimRangeWithId,
		edge: 'start' | 'end',
	) => {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
		event.preventDefault()
		const step = event.shiftKey ? SHIFT_STEP : KEYBOARD_STEP
		const delta = event.key === 'ArrowUp' ? step : -step
		const nextValue = edge === 'start' ? range.start + delta : range.end + delta
		updateTrimRange(
			range.id,
			{
				[edge]: nextValue,
			},
			edge,
		)
		syncVideoToTime(nextValue, { updateInput: true })
	}

	const runTrimCommand = async () => {
		if (runStatus === 'running') return
		const normalized = normalizeTrimRanges(
			trimRanges,
			previewDuration,
			MIN_TRIM_LENGTH,
		)
		if (!videoPathInput.trim()) {
			runStatus = 'error'
			runError = 'Provide a video file path before running ffmpeg.'
			handle.update()
			return
		}
		if (!outputPathInput.trim()) {
			runStatus = 'error'
			runError = 'Provide an output path before running ffmpeg.'
			handle.update()
			return
		}
		if (!previewReady || previewDuration <= 0) {
			runStatus = 'error'
			runError = 'Load the video preview before running ffmpeg.'
			handle.update()
			return
		}
		if (normalized.length === 0) {
			runStatus = 'error'
			runError = 'Add at least one trim range to run ffmpeg.'
			handle.update()
			return
		}
		runStatus = 'running'
		runProgress = 0
		runError = ''
		runLogs = []
		runController = new AbortController()
		handle.update()

		try {
			const response = await fetch('/api/trim', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					inputPath: videoPathInput.trim(),
					outputPath: outputPathInput.trim(),
					duration: previewDuration,
					ranges: normalized,
				}),
				signal: runController.signal,
			})
			if (!response.ok) {
				runStatus = 'error'
				runError = await response.text()
				handle.update()
				return
			}
			const reader = response.body
				?.pipeThrough(new TextDecoderStream())
				.getReader()
			if (!reader) {
				runStatus = 'error'
				runError = 'Streaming response not available.'
				handle.update()
				return
			}
			let buffer = ''
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				buffer += value
				const lines = buffer.split('\n')
				buffer = lines.pop() ?? ''
				for (const line of lines) {
					if (!line.trim()) continue
					let payload: any = null
					try {
						payload = JSON.parse(line)
					} catch {
						runLogs = [...runLogs, line.trim()]
						continue
					}
					if (payload?.type === 'log' && payload.message) {
						runLogs = [...runLogs, payload.message]
					}
					if (payload?.type === 'progress') {
						const nextProgress =
							typeof payload.progress === 'number' ? payload.progress : 0
						runProgress = clamp(nextProgress, 0, 1)
					}
					if (payload?.type === 'done') {
						if (payload.success) {
							runStatus = 'success'
							runProgress = 1
						} else {
							runStatus = 'error'
							runError = payload.error ?? 'ffmpeg failed.'
						}
					}
					handle.update()
				}
			}
			if (runStatus === 'running') {
				runStatus = 'error'
				runError = 'ffmpeg stream ended unexpectedly.'
				handle.update()
			}
		} catch (error) {
			if (runController === null) {
				// Cancellation already set the error message, don't overwrite it
			} else {
				runStatus = 'error'
				runError =
					error instanceof Error ? error.message : 'Unable to run ffmpeg.'
			}
			handle.update()
		} finally {
			runController = null
		}
	}

	const cancelRun = () => {
		if (runController) {
			runController.abort()
			runController = null
		}
		runStatus = 'error'
		runError = 'Run canceled.'
		handle.update()
	}

	return () => {
		const duration = previewDuration
		const sortedRanges = sortRanges(trimRanges)
		const normalizedRanges = normalizeTrimRanges(
			trimRanges,
			duration,
			MIN_TRIM_LENGTH,
		)
		const totalRemoved = normalizedRanges.reduce(
			(total, range) => total + (range.end - range.start),
			0,
		)
		const outputDuration = computeOutputDuration(
			duration,
			trimRanges,
			MIN_TRIM_LENGTH,
		)
		const commandPreview =
			videoPathInput.trim() && outputPathInput.trim() && normalizedRanges.length > 0
				? buildFfmpegCommandPreview({
						inputPath: videoPathInput.trim(),
						outputPath: outputPathInput.trim(),
						ranges: normalizedRanges,
						includeProgress: true,
					})
				: ''
		const progressLabel =
			runStatus === 'running'
				? `${Math.round(runProgress * 100)}%`
				: runStatus === 'success'
					? 'Complete'
					: runStatus === 'error'
						? 'Error'
						: 'Idle'
		const hintId = 'trim-keyboard-hint'
		return (
			<main class="app-shell trim-shell">
				<header class="app-header">
					<span class="app-kicker">Eprec Studio</span>
					<h1 class="app-title">Trim points</h1>
					<p class="app-subtitle">
						Define ranges to remove, preview their timestamps on the timeline,
						and run ffmpeg with live progress.
					</p>
					<nav class="app-nav">
						<a class="app-link" href="/">
							Editing workspace
						</a>
					</nav>
				</header>

				<section class="app-card app-card--full source-card">
					<div class="source-header">
						<div>
							<h2>Video source</h2>
							<p class="app-muted">
								Load a local video file to calculate the trim timeline and output
								command.
							</p>
						</div>
						<span
							class={classNames(
								'status-pill',
								pathStatus === 'ready' && 'status-pill--success',
								pathStatus === 'loading' && 'status-pill--warning',
								pathStatus === 'error' && 'status-pill--danger',
								pathStatus === 'idle' && 'status-pill--info',
							)}
						>
							{pathStatus}
						</span>
					</div>
					<div class="source-grid">
						<div class="source-fields">
							<label class="input-label">
								Video file path
								<input
									class="text-input"
									type="text"
									placeholder="/path/to/video.mp4"
									value={videoPathInput}
									on={{
										input: (event) => {
											const target = event.currentTarget as HTMLInputElement
											updateVideoPathInput(target.value)
										},
									}}
								/>
							</label>
							<label class="input-label">
								Output file path
								<input
									class="text-input"
									type="text"
									placeholder="/path/to/video.trimmed.mp4"
									value={outputPathInput}
									on={{
										input: (event) => {
											const target = event.currentTarget as HTMLInputElement
											updateOutputPathInput(target.value)
										},
									}}
								/>
							</label>
							<div class="source-actions">
								<button
									class="button button--primary"
									type="button"
									disabled={pathStatus === 'loading'}
									on={{ click: () => void loadVideoFromPath() }}
								>
									{pathStatus === 'loading' ? 'Checking...' : 'Load video'}
								</button>
								<button
									class="button button--ghost"
									type="button"
									on={{ click: loadDemoVideo }}
								>
									Use demo video
								</button>
							</div>
							{pathStatus === 'error' && pathError ? (
								<p class="status-note status-note--danger">{pathError}</p>
							) : null}
						</div>
						<div class="trim-preview">
							<div class="panel-header">
								<h3>Preview</h3>
								<span class="summary-subtext">
									{previewReady
										? `Duration ${formatTimestamp(previewDuration)}`
										: 'Load a video to preview'}
								</span>
							</div>
							<video
								class="timeline-video-player"
								src={previewUrl}
								controls
								preload="metadata"
								connect={(node: HTMLVideoElement, signal) => {
									previewNode = node
									const handleLoaded = () => {
										const nextDuration = Number(node.duration)
										previewDuration = Number.isFinite(nextDuration)
											? nextDuration
											: 0
										previewReady = previewDuration > 0
										previewError = ''
										playhead = clamp(playhead, 0, previewDuration)
										if (!isTimeEditing) {
											timeInputValue = formatTimestamp(playhead)
										}
										if (
											Math.abs(node.currentTime - playhead) > 0.02 &&
											previewReady
										) {
											node.currentTime = playhead
										}
										void loadWaveform(previewUrl)
										handle.update()
									}
									const handleTimeUpdate = () => {
										if (!previewReady || previewDuration <= 0) return
										playhead = clamp(node.currentTime, 0, previewDuration)
										if (!isTimeEditing) {
											timeInputValue = formatTimestamp(playhead)
										}
										handle.update()
									}
									const handlePlay = () => {
										previewPlaying = true
										handle.update()
									}
									const handlePause = () => {
										previewPlaying = false
										handle.update()
									}
									const handleError = () => {
										previewError = 'Unable to load the preview video.'
										previewReady = false
										handle.update()
									}
									node.addEventListener('loadedmetadata', handleLoaded)
									node.addEventListener('timeupdate', handleTimeUpdate)
									node.addEventListener('play', handlePlay)
									node.addEventListener('pause', handlePause)
									node.addEventListener('error', handleError)
									signal.addEventListener('abort', () => {
										node.removeEventListener('loadedmetadata', handleLoaded)
										node.removeEventListener('timeupdate', handleTimeUpdate)
										node.removeEventListener('play', handlePlay)
										node.removeEventListener('pause', handlePause)
										node.removeEventListener('error', handleError)
										if (previewNode === node) {
											previewNode = null
										}
									})
								}}
							/>
							{previewError ? (
								<p class="status-note status-note--danger">{previewError}</p>
							) : null}
							<div class="trim-time-row">
								<label class="input-label">
									Video time
									<input
										class="text-input text-input--compact"
										type="text"
										placeholder="00:00.00"
										value={timeInputValue}
										disabled={!previewReady}
										on={{
											focus: () => {
												isTimeEditing = true
												handle.update()
											},
											input: (event) => {
												const target = event.currentTarget as HTMLInputElement
												updateTimeInput(target.value)
											},
											blur: () => commitTimeInput(),
											keydown: (event) => {
												if (event.key === 'Enter') {
													event.preventDefault()
													commitTimeInput()
												}
												if (event.key === 'Escape') {
													event.preventDefault()
													isTimeEditing = false
													timeInputValue = formatTimestamp(playhead)
													handle.update()
												}
											},
										}}
									/>
								</label>
								<span class="summary-subtext">
									{previewPlaying ? 'Playing' : 'Paused'}
								</span>
							</div>
						</div>
					</div>
				</section>

				<section class="app-card app-card--full timeline-card">
					<div class="timeline-header">
						<div>
							<h2>Trim timeline</h2>
							<p class="app-muted">
								Drag the trim handles or use arrow keys to fine-tune start and
								end timestamps.
							</p>
						</div>
						<button
							class="button button--primary"
							type="button"
							disabled={!previewReady}
							on={{ click: addTrimRange }}
						>
							Add trim range
						</button>
					</div>
					<p class="app-muted trim-hint" id={hintId}>
						Use arrow keys to nudge by {KEYBOARD_STEP}s. Hold Shift for {SHIFT_STEP}
						s.
					</p>
					<div
						class={classNames(
							'trim-track',
							!previewReady && 'trim-track--disabled',
						)}
						connect={(node: HTMLDivElement) => {
							trackNode = node
						}}
						style={`--playhead:${duration > 0 ? (playhead / duration) * 100 : 0}%`}
					>
						<canvas
							class="trim-waveform"
							connect={(node: HTMLCanvasElement, signal) => {
								waveformNode = node
								drawWaveform()
								if (typeof ResizeObserver === 'undefined') return
								const observer = new ResizeObserver(() => drawWaveform())
								observer.observe(node)
								signal.addEventListener('abort', () => {
									observer.disconnect()
									if (waveformNode === node) {
										waveformNode = null
									}
								})
							}}
						/>
						{sortedRanges.map((range) => (
							<div
								class={classNames(
									'trim-range',
									range.id === selectedRangeId && 'is-selected',
								)}
								style={`--range-left:${duration > 0 ? (range.start / duration) * 100 : 0}%; --range-width:${duration > 0 ? ((range.end - range.start) / duration) * 100 : 0}%`}
								on={{ click: () => selectRange(range.id) }}
								role="group"
								aria-label={`Trim range ${formatTimestamp(range.start)} to ${formatTimestamp(range.end)}`}
							>
								<span class="trim-range-label">
									Remove {formatTimestamp(range.start)} -{' '}
									{formatTimestamp(range.end)}
								</span>
								<span class="trim-handle-label trim-handle-label--start">
									{formatTimestamp(range.start)}
								</span>
								<button
									type="button"
									class="trim-handle trim-handle--start"
									role="slider"
									aria-label="Trim start"
									aria-valuemin={0}
									aria-valuemax={duration}
									aria-valuenow={range.start}
									aria-valuetext={formatTimestamp(range.start)}
									aria-describedby={hintId}
									on={{
										focus: () =>
											syncVideoToTime(range.start, { updateInput: true }),
										pointerdown: (event) =>
											startDrag(event, range.id, 'start'),
										pointermove: moveDrag,
										pointerup: endDrag,
										pointercancel: endDrag,
										keydown: (event) => handleRangeKey(event, range, 'start'),
									}}
								/>
								<span class="trim-handle-label trim-handle-label--end">
									{formatTimestamp(range.end)}
								</span>
								<button
									type="button"
									class="trim-handle trim-handle--end"
									role="slider"
									aria-label="Trim end"
									aria-valuemin={0}
									aria-valuemax={duration}
									aria-valuenow={range.end}
									aria-valuetext={formatTimestamp(range.end)}
									aria-describedby={hintId}
									on={{
										focus: () =>
											syncVideoToTime(range.end, { updateInput: true }),
										pointerdown: (event) => startDrag(event, range.id, 'end'),
										pointermove: moveDrag,
										pointerup: endDrag,
										pointercancel: endDrag,
										keydown: (event) => handleRangeKey(event, range, 'end'),
									}}
								/>
							</div>
						))}
						<span class="trim-playhead" />
					</div>
					<div class="trim-waveform-meta">
						{waveformStatus === 'loading' ? (
							<span class="summary-subtext">Rendering waveform...</span>
						) : waveformStatus === 'error' ? (
							<span class="summary-subtext">{waveformError}</span>
						) : (
							<span class="summary-subtext">
								Waveform {waveformSamples.length > 0 ? 'ready' : 'idle'}
							</span>
						)}
					</div>
					<div class="timeline-controls">
						<label class="control-label">
							Playhead
							<span class="control-value">{formatTimestamp(playhead)}</span>
						</label>
						<input
							class="timeline-slider"
							type="range"
							min="0"
							max={duration || 1}
							step={PLAYHEAD_STEP}
							value={playhead}
							disabled={!previewReady}
							on={{
								input: (event) => {
									const target = event.currentTarget as HTMLInputElement
									setPlayhead(Number(target.value))
								},
							}}
						/>
						<button
							class="button button--ghost"
							type="button"
							disabled={!previewReady || sortedRanges.length === 0}
							on={{
								click: () => {
									const next = sortedRanges.find(
										(range) => range.start > playhead,
									)
									if (next) setPlayhead(next.start)
								},
							}}
						>
							Next trim
						</button>
					</div>
				</section>

				<div class="app-grid app-grid--two trim-grid">
					<section class="app-card">
						<div class="panel-header">
							<h2>Trim ranges</h2>
							<span class="summary-subtext">
								{sortedRanges.length} total
							</span>
						</div>
						{sortedRanges.length === 0 ? (
							<p class="app-muted">
								Add a trim range to start removing segments.
							</p>
						) : (
							<ul class="stacked-list trim-range-list">
								{sortedRanges.map((range) => (
									<li
										class={classNames(
											'stacked-item',
											'trim-range-row',
											range.id === selectedRangeId && 'is-selected',
										)}
									>
										<button
											class="trim-range-summary"
											type="button"
											on={{ click: () => selectRange(range.id) }}
										>
											<span class="trim-range-time">
												{formatTimestamp(range.start)} -{' '}
												{formatTimestamp(range.end)}
											</span>
											<span class="summary-subtext">
												Remove {formatSeconds(range.end - range.start)}
											</span>
										</button>
										<div class="trim-range-fields">
											<label class="input-label">
												Start
												<input
													class="text-input text-input--compact"
													type="number"
													min="0"
													max={duration}
													step={KEYBOARD_STEP}
													value={range.start.toFixed(2)}
													on={{
														focus: () =>
															syncVideoToTime(range.start, {
																updateInput: true,
															}),
														input: (event) => {
															const target =
																event.currentTarget as HTMLInputElement
															const nextValue = Number(target.value)
															if (!Number.isFinite(nextValue)) return
															updateTrimRange(
																range.id,
																{ start: nextValue },
																'start',
															)
															syncVideoToTime(nextValue, {
																updateInput: true,
															})
														},
														keydown: (event) =>
															handleNumberKey(event, range, 'start'),
													}}
												/>
											</label>
											<label class="input-label">
												End
												<input
													class="text-input text-input--compact"
													type="number"
													min="0"
													max={duration}
													step={KEYBOARD_STEP}
													value={range.end.toFixed(2)}
													on={{
														focus: () =>
															syncVideoToTime(range.end, {
																updateInput: true,
															}),
														input: (event) => {
															const target =
																event.currentTarget as HTMLInputElement
															const nextValue = Number(target.value)
															if (!Number.isFinite(nextValue)) return
															updateTrimRange(
																range.id,
																{ end: nextValue },
																'end',
															)
															syncVideoToTime(nextValue, {
																updateInput: true,
															})
														},
														keydown: (event) =>
															handleNumberKey(event, range, 'end'),
													}}
												/>
											</label>
											<button
												class="button button--ghost"
												type="button"
												on={{ click: () => removeTrimRange(range.id) }}
											>
												Remove
											</button>
										</div>
									</li>
								))}
							</ul>
						)}
					</section>

					<section class="app-card">
						<h2>Output summary</h2>
						<div class="summary-grid">
							<div class="summary-item">
								<span class="summary-label">Removed</span>
								<span class="summary-value">{formatSeconds(totalRemoved)}</span>
								<span class="summary-subtext">
									{normalizedRanges.length} normalized ranges
								</span>
							</div>
							<div class="summary-item">
								<span class="summary-label">Output length</span>
								<span class="summary-value">
									{previewReady
										? formatTimestamp(outputDuration)
										: '--:--.--'}
								</span>
								<span class="summary-subtext">
									{previewReady && duration > 0
										? `${Math.round((outputDuration / duration) * 100)}% kept`
										: 'Load a video to calculate'}
								</span>
							</div>
							<div class="summary-item">
								<span class="summary-label">Command status</span>
								<span class="summary-value">{progressLabel}</span>
								<span class="summary-subtext">
									{runStatus === 'running'
										? 'ffmpeg in progress'
										: 'Ready to run'}
								</span>
							</div>
						</div>
					</section>
				</div>

				<section class="app-card app-card--full trim-command-card">
					<div class="panel-header">
						<h2>ffmpeg command</h2>
						<div class="trim-command-actions">
							<button
								class="button button--primary"
								type="button"
								disabled={runStatus === 'running' || !commandPreview}
								on={{ click: runTrimCommand }}
							>
								{runStatus === 'running' ? 'Running...' : 'Run ffmpeg'}
							</button>
							<button
								class="button button--ghost"
								type="button"
								disabled={runStatus !== 'running'}
								on={{ click: cancelRun }}
							>
								Cancel
							</button>
						</div>
					</div>
					<p class="app-muted">
						Use this command in your terminal, or run it here to watch progress
						stream back into the UI.
					</p>
					{commandPreview ? (
						<pre class="command-preview">{commandPreview}</pre>
					) : (
						<p class="status-note status-note--warning">
							Load a video and add at least one trim range to generate the
							command.
						</p>
					)}
					<div class="trim-progress">
						<progress max="1" value={runProgress} />
						<span class="summary-subtext">{progressLabel}</span>
					</div>
					{runError ? (
						<p class="status-note status-note--danger">{runError}</p>
					) : null}
					<pre class="command-preview trim-output">
						{runLogs.length > 0
							? runLogs.slice(-200).join('\n')
							: 'ffmpeg output will appear here.'}
					</pre>
				</section>
			</main>
		)
	}
}
