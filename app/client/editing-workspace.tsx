import { matchSorter } from 'match-sorter'
import type { Handle } from 'remix/component'
import {
	sampleEditSession,
	type ChapterPlan,
	type ChapterStatus,
	type CommandWindow,
	type CutRange,
	type TranscriptWord,
} from './edit-session-data.ts'

type AppConfig = {
	initialVideoPath?: string
}

declare global {
	interface Window {
		__EPREC_APP__?: AppConfig
	}
}

const MIN_CUT_LENGTH = 0.2
const DEFAULT_CUT_LENGTH = 2.4
const PLAYHEAD_STEP = 0.1
const DEFAULT_PREVIEW_URL = '/e2e-test.mp4'

function readInitialVideoPath() {
	if (typeof window === 'undefined') return ''
	const raw = window.__EPREC_APP__?.initialVideoPath
	if (typeof raw !== 'string') return ''
	return raw.trim()
}

function buildVideoPreviewUrl(value: string) {
	return `/api/video?path=${encodeURIComponent(value)}`
}

function extractVideoName(value: string) {
	const normalized = value.replace(/\\/g, '/')
	const parts = normalized.split('/')
	const last = parts[parts.length - 1]
	return last && last.length > 0 ? last : value
}

type ProcessingStatus = 'queued' | 'running' | 'done'
type ProcessingCategory = 'chapter' | 'transcript' | 'export'
type ProcessingTask = {
	id: string
	title: string
	detail: string
	status: ProcessingStatus
	category: ProcessingCategory
}

export function EditingWorkspace(handle: Handle) {
	const duration = sampleEditSession.duration
	const transcript = sampleEditSession.transcript
	const commands = sampleEditSession.commands
	const transcriptIndex = transcript.map((word) => ({
		...word,
		context: buildContext(transcript, word.index, 3),
	}))
	const initialVideoPath = readInitialVideoPath()
	let sourceName = sampleEditSession.sourceName
	let sourcePath = ''
	let previewUrl = DEFAULT_PREVIEW_URL
	let previewSource: 'demo' | 'path' = 'demo'
	let videoPathInput = initialVideoPath
	let pathStatus: 'idle' | 'loading' | 'ready' | 'error' = initialVideoPath
		? 'loading'
		: 'idle'
	let pathError = ''
	let previewError = ''
	let cutRanges = sampleEditSession.cuts.map((range) => ({ ...range }))
	let chapters = sampleEditSession.chapters.map((chapter) => ({ ...chapter }))
	let playhead = 18.2
	let selectedRangeId = cutRanges[0]?.id ?? null
	let searchQuery = ''
	let primaryChapterId = chapters[0]?.id ?? ''
	let secondaryChapterId = chapters[1]?.id ?? chapters[0]?.id ?? ''
	let processingQueue: ProcessingTask[] = []
	let activeTaskId: string | null = null
	let processingCount = 1
	let manualCutId = 1
	let previewDuration = 0
	let previewReady = false
	let previewPlaying = false
	let previewNode: HTMLVideoElement | null = null
	let lastSyncedPlayhead = playhead
	let isScrubbing = false

	const resetPreviewState = () => {
		previewReady = false
		previewPlaying = false
		previewDuration = 0
		previewError = ''
		lastSyncedPlayhead = playhead
	}

	const updateVideoPathInput = (value: string) => {
		videoPathInput = value
		if (pathError) pathError = ''
		if (pathStatus === 'error') pathStatus = 'idle'
		handle.update()
	}

	const applyPreviewSource = (options: {
		url: string
		name: string
		source: 'demo' | 'path'
		path?: string
	}) => {
		previewUrl = options.url
		sourceName = options.name
		sourcePath = options.path ?? ''
		previewSource = options.source
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
			applyPreviewSource({
				url: preview,
				name: extractVideoName(candidate),
				source: 'path',
				path: candidate,
			})
		} catch (error) {
			if (handle.signal.aborted) return
			pathStatus = 'error'
			pathError =
				error instanceof Error ? error.message : 'Unable to load the video.'
			handle.update()
		}
	}

	const resetToDemo = () => {
		pathStatus = 'idle'
		pathError = ''
		videoPathInput = ''
		applyPreviewSource({
			url: DEFAULT_PREVIEW_URL,
			name: sampleEditSession.sourceName,
			source: 'demo',
		})
	}

	if (initialVideoPath) {
		void loadVideoFromPath(initialVideoPath)
	}

	const setPlayhead = (value: number) => {
		playhead = clamp(value, 0, duration)
		syncVideoToPlayhead(playhead)
		handle.update()
	}

	const startScrubbing = () => {
		isScrubbing = true
	}

	const stopScrubbing = () => {
		if (!isScrubbing) return
		isScrubbing = false
		syncVideoToPlayhead(playhead)
	}

	const selectRange = (rangeId: string) => {
		selectedRangeId = rangeId
		handle.update()
	}

	const addManualCut = () => {
		const start = clamp(playhead, 0, duration - MIN_CUT_LENGTH)
		const end = clamp(
			start + DEFAULT_CUT_LENGTH,
			start + MIN_CUT_LENGTH,
			duration,
		)
		const newRange: CutRange = {
			id: `manual-${manualCutId++}`,
			start,
			end,
			reason: 'Manual trim added from the timeline.',
			source: 'manual',
		}
		cutRanges = sortRanges([...cutRanges, newRange])
		selectedRangeId = newRange.id
		handle.update()
	}

	const removeCut = (rangeId: string) => {
		cutRanges = cutRanges.filter((range) => range.id !== rangeId)
		if (selectedRangeId === rangeId) {
			selectedRangeId = cutRanges[0]?.id ?? null
		}
		handle.update()
	}

	const updateCutRange = (rangeId: string, patch: Partial<CutRange>) => {
		cutRanges = sortRanges(
			cutRanges.map((range) => {
				if (range.id !== rangeId) return range
				return normalizeRange({ ...range, ...patch }, duration)
			}),
		)
		selectedRangeId = rangeId
		handle.update()
	}

	const applyCommand = (command: CommandWindow) => {
		if (command.action === 'remove') {
			if (isCommandApplied(command, cutRanges, chapters)) return
			const range: CutRange = {
				id: `command-${command.id}`,
				start: command.start,
				end: command.end,
				reason: `Jarvis command: ${command.label}.`,
				source: 'command',
				sourceId: command.id,
			}
			cutRanges = sortRanges([...cutRanges, normalizeRange(range, duration)])
			selectedRangeId = range.id
			handle.update()
			return
		}

		if (command.action === 'rename' && command.value) {
			chapters = chapters.map((chapter) =>
				chapter.id === command.chapterId
					? { ...chapter, outputName: command.value, status: 'review' }
					: chapter,
			)
			handle.update()
			return
		}

		if (command.action === 'skip') {
			chapters = chapters.map((chapter) =>
				chapter.id === command.chapterId
					? { ...chapter, status: 'skipped' }
					: chapter,
			)
			handle.update()
		}
	}

	const updateChapterStatus = (chapterId: string, status: ChapterStatus) => {
		chapters = chapters.map((chapter) =>
			chapter.id === chapterId ? { ...chapter, status } : chapter,
		)
		handle.update()
	}

	const updateChapterOutput = (chapterId: string, outputName: string) => {
		chapters = chapters.map((chapter) =>
			chapter.id === chapterId ? { ...chapter, outputName } : chapter,
		)
		handle.update()
	}

	const updateSearchQuery = (value: string) => {
		searchQuery = value
		handle.update()
	}

	const findChapter = (chapterId: string) =>
		chapters.find((chapter) => chapter.id === chapterId) ?? null

	const updatePrimaryChapter = (chapterId: string) => {
		primaryChapterId = chapterId
		if (secondaryChapterId === chapterId) {
			secondaryChapterId =
				chapters.find((chapter) => chapter.id !== chapterId)?.id ?? chapterId
		}
		handle.update()
	}

	const updateSecondaryChapter = (chapterId: string) => {
		secondaryChapterId = chapterId
		handle.update()
	}

	const queueTask = (
		title: string,
		detail: string,
		category: ProcessingCategory,
	) => {
		const task: ProcessingTask = {
			id: `task-${processingCount++}`,
			title,
			detail,
			status: 'queued',
			category,
		}
		processingQueue = [...processingQueue, task]
		handle.update()
	}

	const queueChapterEdit = () => {
		const chapter = findChapter(primaryChapterId)
		if (!chapter) return
		queueTask(
			`Edit ${chapter.title}`,
			`Review trims for ${formatTimestamp(chapter.start)} - ${formatTimestamp(
				chapter.end,
			)}.`,
			'chapter',
		)
	}

	const queueCombineChapters = () => {
		const primary = findChapter(primaryChapterId)
		const secondary = findChapter(secondaryChapterId)
		if (!primary || !secondary || primary.id === secondary.id) return
		queueTask(
			`Combine ${primary.title} + ${secondary.title}`,
			'Merge both chapters into a single preview export.',
			'chapter',
		)
	}

	const queueTranscriptRegeneration = () => {
		queueTask(
			'Regenerate transcript',
			'Run Whisper alignment and refresh search cues.',
			'transcript',
		)
	}

	const queueCommandScan = () => {
		queueTask(
			'Detect command windows',
			'Scan for Jarvis commands and update cut ranges.',
			'transcript',
		)
	}

	const queuePreviewRender = () => {
		queueTask(
			'Render preview clip',
			'Bake a short MP4 with current edits applied.',
			'export',
		)
	}

	const queueFinalExport = () => {
		queueTask(
			'Export edited chapters',
			'Render final chapters and write the export package.',
			'export',
		)
	}

	const startNextTask = () => {
		if (activeTaskId) return
		const next = processingQueue.find((task) => task.status === 'queued')
		if (!next) return
		activeTaskId = next.id
		processingQueue = processingQueue.map((task) =>
			task.id === next.id ? { ...task, status: 'running' } : task,
		)
		handle.update()
	}

	const markActiveDone = () => {
		if (!activeTaskId) return
		processingQueue = processingQueue.map((task) =>
			task.id === activeTaskId ? { ...task, status: 'done' } : task,
		)
		activeTaskId = null
		handle.update()
	}

	const clearCompletedTasks = () => {
		processingQueue = processingQueue.filter((task) => task.status !== 'done')
		handle.update()
	}

	const removeTask = (taskId: string) => {
		processingQueue = processingQueue.filter((task) => task.id !== taskId)
		if (activeTaskId === taskId) {
			activeTaskId = null
		}
		handle.update()
	}

	const syncVideoToPlayhead = (value: number) => {
		if (
			!previewNode ||
			!previewReady ||
			duration <= 0 ||
			previewDuration <= 0
		) {
			return
		}
		const targetTime = clamp(
			(value / duration) * previewDuration,
			0,
			previewDuration,
		)
		lastSyncedPlayhead = value
		if (Math.abs(previewNode.currentTime - targetTime) > 0.05) {
			previewNode.currentTime = targetTime
		}
	}

	return () => {
		const sortedCuts = sortRanges(cutRanges)
		const selectedRange = selectedRangeId
			? (sortedCuts.find((range) => range.id === selectedRangeId) ?? null)
			: null
		const mergedCuts = mergeOverlappingRanges(sortedCuts)
		const totalRemoved = mergedCuts.reduce(
			(total, range) => total + (range.end - range.start),
			0,
		)
		const finalDuration = Math.max(duration - totalRemoved, 0)
		const currentWord = findWordAtTime(transcript, playhead)
		const currentContext = currentWord
			? buildContext(transcript, currentWord.index, 4)
			: 'No transcript cues found for the playhead.'
		const query = searchQuery.trim()
		const searchResults = query
			? matchSorter(transcriptIndex, query, {
					keys: ['word'],
				}).slice(0, 12)
			: []
		const queuedCount = processingQueue.filter(
			(task) => task.status === 'queued',
		).length
		const completedCount = processingQueue.filter(
			(task) => task.status === 'done',
		).length
		const runningTask =
			processingQueue.find((task) => task.status === 'running') ?? null
		const canCombineChapters =
			primaryChapterId.length > 0 &&
			secondaryChapterId.length > 0 &&
			primaryChapterId !== secondaryChapterId
		const commandPreview = buildCommandPreview(sourceName, chapters, sourcePath)
		const previewTime =
			previewReady && previewDuration > 0
				? (playhead / duration) * previewDuration
				: 0
		const previewStatus = previewError
			? { label: 'Error', className: 'status-pill--danger' }
			: previewReady
				? previewPlaying
					? { label: 'Playing', className: 'status-pill--info' }
					: { label: 'Ready', className: 'status-pill--success' }
				: { label: 'Loading', className: 'status-pill--warning' }
		const sourceStatus =
			previewSource === 'path'
				? { label: 'Path', className: 'status-pill--success' }
				: { label: 'Demo', className: 'status-pill--info' }

		return (
			<main class="app-shell">
				<header class="app-header">
					<span class="app-kicker">Eprec Studio</span>
					<h1 class="app-title">Editing workspace</h1>
					<p class="app-subtitle">
						Review transcript-based edits, refine command windows, and prepare
						the final CLI export in one place.
					</p>
				</header>

				<section class="app-card app-card--full source-card">
					<div class="source-header">
						<div>
							<h2>Source video</h2>
							<p class="app-muted">
								Paste a full video path to preview it and update the CLI export.
							</p>
						</div>
						<span
							class={classNames('status-pill', sourceStatus.className)}
							title={`Preview source: ${sourceStatus.label}`}
						>
							{sourceStatus.label}
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
							<div class="source-actions">
								<button
									class="button button--primary"
									type="button"
									disabled={
										pathStatus === 'loading' ||
										videoPathInput.trim().length === 0
									}
									on={{ click: () => void loadVideoFromPath() }}
								>
									{pathStatus === 'loading' ? 'Checking...' : 'Load from path'}
								</button>
								<button
									class="button button--ghost"
									type="button"
									on={{ click: resetToDemo }}
								>
									Use demo video
								</button>
							</div>
							{pathStatus === 'error' && pathError ? (
								<p class="status-note status-note--danger">{pathError}</p>
							) : null}
						</div>
					</div>
				</section>

				<section class="app-card app-card--full">
					<h2>Session summary</h2>
					<div class="summary-grid">
						<div class="summary-item">
							<span class="summary-label">Source video</span>
							<span class="summary-value">{sourceName}</span>
							{sourcePath ? (
								<span class="summary-subtext">{sourcePath}</span>
							) : (
								<span class="summary-subtext">Demo fixture video</span>
							)}
							<span class="summary-subtext">
								Duration {formatTimestamp(duration)}
							</span>
						</div>
						<div class="summary-item">
							<span class="summary-label">Cuts</span>
							<span class="summary-value">{sortedCuts.length} ranges</span>
							<span class="summary-subtext">
								{formatSeconds(totalRemoved)} removed
							</span>
						</div>
						<div class="summary-item">
							<span class="summary-label">Output length</span>
							<span class="summary-value">
								{formatTimestamp(finalDuration)}
							</span>
							<span class="summary-subtext">
								{Math.round((finalDuration / duration) * 100)}% retained
							</span>
						</div>
						<div class="summary-item">
							<span class="summary-label">Commands</span>
							<span class="summary-value">{commands.length} detected</span>
							<span class="summary-subtext">
								{
									commands.filter((command) =>
										isCommandApplied(command, sortedCuts, chapters),
									).length
								}{' '}
								applied
							</span>
						</div>
					</div>
				</section>

				<section class="app-card app-card--full actions-card">
					<div class="actions-header">
						<div>
							<h2>Processing actions</h2>
							<p class="app-muted">
								Queue chapter edits, transcript cleanup, and export jobs
								directly from the workspace.
							</p>
						</div>
						<div class="actions-meta">
							<div class="summary-item">
								<span class="summary-label">Queue</span>
								<span class="summary-value">{queuedCount} queued</span>
								<span class="summary-subtext">
									{runningTask ? `Running: ${runningTask.title}` : 'Idle'}
								</span>
							</div>
						</div>
						<div class="actions-buttons">
							<button
								class="button button--primary"
								type="button"
								disabled={queuedCount === 0 || Boolean(runningTask)}
								on={{ click: startNextTask }}
							>
								Run next
							</button>
							<button
								class="button button--ghost"
								type="button"
								disabled={!runningTask}
								on={{ click: markActiveDone }}
							>
								Mark running done
							</button>
							<button
								class="button button--ghost"
								type="button"
								disabled={completedCount === 0}
								on={{ click: clearCompletedTasks }}
							>
								Clear completed
							</button>
						</div>
					</div>

					<div class="actions-grid">
						<article class="actions-panel">
							<div class="panel-header">
								<h3>Chapter processing</h3>
								<span class="status-pill status-pill--info">Chapter</span>
							</div>
							<label class="input-label">
								Primary chapter
								<select
									class="text-input"
									value={primaryChapterId}
									on={{
										change: (event) => {
											const target = event.currentTarget as HTMLSelectElement
											updatePrimaryChapter(target.value)
										},
									}}
								>
									{chapters.map((chapter) => (
										<option value={chapter.id}>{chapter.title}</option>
									))}
								</select>
							</label>
							<label class="input-label">
								Secondary chapter
								<select
									class="text-input"
									value={secondaryChapterId}
									on={{
										change: (event) => {
											const target = event.currentTarget as HTMLSelectElement
											updateSecondaryChapter(target.value)
										},
									}}
								>
									{chapters.map((chapter) => (
										<option value={chapter.id}>{chapter.title}</option>
									))}
								</select>
							</label>
							<div class="actions-button-row">
								<button
									class="button button--primary"
									type="button"
									disabled={!primaryChapterId}
									on={{ click: queueChapterEdit }}
								>
									Edit chapter
								</button>
								<button
									class="button button--ghost"
									type="button"
									disabled={!canCombineChapters}
									on={{ click: queueCombineChapters }}
								>
									Combine chapters
								</button>
							</div>
							<p class="app-muted">
								Stage edits or merge two chapters without leaving this view.
							</p>
						</article>

						<article class="actions-panel">
							<div class="panel-header">
								<h3>Transcript utilities</h3>
								<span class="status-pill status-pill--warning">Transcript</span>
							</div>
							<div class="actions-button-row">
								<button
									class="button button--ghost"
									type="button"
									on={{ click: queueTranscriptRegeneration }}
								>
									Regenerate transcript
								</button>
								<button
									class="button button--ghost"
									type="button"
									on={{ click: queueCommandScan }}
								>
									Detect command windows
								</button>
							</div>
							<p class="app-muted">
								Refresh the transcript or scan for command markers on demand.
							</p>
						</article>

						<article class="actions-panel">
							<div class="panel-header">
								<h3>Exports</h3>
								<span class="status-pill status-pill--success">Export</span>
							</div>
							<div class="actions-button-row">
								<button
									class="button button--ghost"
									type="button"
									on={{ click: queuePreviewRender }}
								>
									Render preview clip
								</button>
								<button
									class="button button--ghost"
									type="button"
									on={{ click: queueFinalExport }}
								>
									Export edited chapters
								</button>
							</div>
							<p class="app-muted">
								Trigger preview renders or finalize exports for the pipeline.
							</p>
						</article>
					</div>

					<div class="actions-queue">
						<div class="panel-header">
							<h3>Processing queue</h3>
							<span class="summary-subtext">
								{processingQueue.length} total
							</span>
						</div>
						{processingQueue.length === 0 ? (
							<p class="app-muted">
								No actions queued yet. Use the buttons above to stage work.
							</p>
						) : (
							<ul class="stacked-list processing-list">
								{processingQueue.map((task) => (
									<li
										class={classNames(
											'stacked-item',
											'processing-row',
											task.status === 'running' && 'is-running',
											task.status === 'done' && 'is-complete',
										)}
									>
										<div class="processing-row-header">
											<div>
												<h4>{task.title}</h4>
												<p class="app-muted">{task.detail}</p>
											</div>
											<span
												class={classNames(
													'status-pill',
													task.status === 'queued' && 'status-pill--info',
													task.status === 'running' && 'status-pill--warning',
													task.status === 'done' && 'status-pill--success',
												)}
											>
												{task.status}
											</span>
										</div>
										<div class="processing-row-meta">
											<span class="summary-subtext">
												{formatProcessingCategory(task.category)}
											</span>
											{task.status === 'queued' ? (
												<button
													class="button button--ghost"
													type="button"
													on={{ click: () => removeTask(task.id) }}
												>
													Remove
												</button>
											) : null}
										</div>
									</li>
								))}
							</ul>
						)}
					</div>
				</section>

				<section class="app-card app-card--full timeline-card">
					<div class="timeline-header">
						<div>
							<h2>Timeline editor</h2>
							<p class="app-muted">
								Adjust cut ranges, jump between transcript cues, and add manual
								trims.
							</p>
						</div>
						<button
							class="button button--primary"
							type="button"
							on={{ click: addManualCut }}
						>
							Add cut at playhead
						</button>
					</div>

					<div class="timeline-layout">
						<div class="timeline-preview">
							<div class="timeline-video">
								<div class="timeline-video-header">
									<div>
										<span class="summary-label">Preview video</span>
										<span class="summary-subtext">
											Scrub the timeline or play to sync the preview.
										</span>
									</div>
									<span
										class={classNames('status-pill', previewStatus.className)}
									>
										{previewStatus.label}
									</span>
								</div>
								<video
									class="timeline-video-player"
									src={previewUrl}
									controls
									preload="metadata"
									connect={(node: HTMLVideoElement, signal) => {
										previewNode = node
										const handleLoadedMetadata = () => {
											const nextDuration = Number(node.duration)
											previewDuration = Number.isFinite(nextDuration)
												? nextDuration
												: 0
											previewReady = previewDuration > 0
											previewError = ''
											syncVideoToPlayhead(playhead)
											handle.update()
										}
										const handleTimeUpdate = () => {
											if (!previewReady || previewDuration <= 0) return
											if (isScrubbing) return
											if (!previewPlaying) return
											const mapped =
												(node.currentTime / previewDuration) * duration
											if (Math.abs(mapped - lastSyncedPlayhead) <= 0.05) {
												return
											}
											playhead = clamp(mapped, 0, duration)
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
											previewPlaying = false
											handle.update()
										}
										node.addEventListener(
											'loadedmetadata',
											handleLoadedMetadata,
										)
										node.addEventListener('timeupdate', handleTimeUpdate)
										node.addEventListener('play', handlePlay)
										node.addEventListener('pause', handlePause)
										node.addEventListener('error', handleError)
										signal.addEventListener('abort', () => {
											node.removeEventListener(
												'loadedmetadata',
												handleLoadedMetadata,
											)
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
								<div class="timeline-video-meta">
									<span>Preview {formatTimestamp(previewTime)}</span>
									<span class="app-muted">
										Timeline {formatTimestamp(playhead)}
									</span>
								</div>
								{previewError ? (
									<p class="status-note status-note--danger">{previewError}</p>
								) : null}
							</div>
							<div
								class="timeline-track"
								style={`--playhead:${(playhead / duration) * 100}%`}
							>
								{sortedCuts.map((range) => (
									<button
										type="button"
										class={classNames(
											'timeline-range',
											range.source === 'manual'
												? 'timeline-range--manual'
												: 'timeline-range--command',
											range.id === selectedRangeId && 'is-selected',
										)}
										style={`--range-left:${(range.start / duration) * 100}%; --range-width:${((range.end - range.start) / duration) * 100}%`}
										on={{ click: () => selectRange(range.id) }}
										title={`${range.reason} (${formatTimestamp(range.start)} - ${formatTimestamp(range.end)})`}
									/>
								))}
								<span class="timeline-playhead" />
							</div>
							<div class="timeline-scale">
								{buildTimelineTicks(duration, 6).map((tick) => (
									<span>{formatTimestamp(tick)}</span>
								))}
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
									max={duration}
									step={PLAYHEAD_STEP}
									value={playhead}
									on={{
										input: (event) => {
											const target = event.currentTarget as HTMLInputElement
											startScrubbing()
											setPlayhead(Number(target.value))
										},
										pointerdown: startScrubbing,
										pointerup: stopScrubbing,
										pointercancel: stopScrubbing,
										keydown: startScrubbing,
										keyup: stopScrubbing,
										blur: stopScrubbing,
									}}
								/>
								<button
									class="button button--ghost"
									type="button"
									on={{
										click: () => {
											const previous = findPreviousCut(sortedCuts, playhead)
											if (previous) setPlayhead(previous.start)
										},
									}}
								>
									Prev cut
								</button>
								<button
									class="button button--ghost"
									type="button"
									on={{
										click: () => {
											const next = sortedCuts.find(
												(range) => range.start > playhead,
											)
											if (next) setPlayhead(next.start)
										},
									}}
								>
									Next cut
								</button>
							</div>
						</div>

						<div class="timeline-editor">
							<div class="panel-header">
								<h3>Selected cut</h3>
								{selectedRange ? (
									<span
										class={classNames(
											'status-pill',
											selectedRange.source === 'manual'
												? 'status-pill--warning'
												: 'status-pill--danger',
										)}
									>
										{selectedRange.source === 'manual' ? 'Manual' : 'Command'}
									</span>
								) : null}
							</div>
							{selectedRange ? (
								<div class="panel-grid">
									<label class="input-label">
										Start
										<input
											class="text-input text-input--compact"
											type="number"
											min="0"
											max={duration}
											step="0.1"
											value={selectedRange.start.toFixed(2)}
											on={{
												input: (event) => {
													const target = event.currentTarget as HTMLInputElement
													updateCutRange(selectedRange.id, {
														start: Number(target.value),
													})
												},
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
											step="0.1"
											value={selectedRange.end.toFixed(2)}
											on={{
												input: (event) => {
													const target = event.currentTarget as HTMLInputElement
													updateCutRange(selectedRange.id, {
														end: Number(target.value),
													})
												},
											}}
										/>
									</label>
									<label class="input-label input-label--full">
										Reason
										<input
											class="text-input"
											type="text"
											value={selectedRange.reason}
											on={{
												input: (event) => {
													const target = event.currentTarget as HTMLInputElement
													updateCutRange(selectedRange.id, {
														reason: target.value,
													})
												},
											}}
										/>
									</label>
									<button
										class="button button--danger"
										type="button"
										on={{ click: () => removeCut(selectedRange.id) }}
									>
										Remove cut
									</button>
								</div>
							) : (
								<p class="app-muted">
									Select a cut range to inspect or adjust.
								</p>
							)}

							<h3>Cut list</h3>
							<ul class="cut-list stacked-list">
								{sortedCuts.map((range) => (
									<li
										class={classNames(
											'stacked-item',
											'cut-row',
											range.id === selectedRangeId && 'is-selected',
										)}
									>
										<button
											class="cut-select"
											type="button"
											on={{ click: () => selectRange(range.id) }}
										>
											<span class="cut-time">
												{formatTimestamp(range.start)} -{' '}
												{formatTimestamp(range.end)}
											</span>
											<span class="cut-reason">{range.reason}</span>
										</button>
										<button
											class="button button--ghost"
											type="button"
											on={{ click: () => removeCut(range.id) }}
										>
											Remove
										</button>
									</li>
								))}
							</ul>
						</div>
					</div>
				</section>

				<div class="app-grid app-grid--two">
					<section class="app-card">
						<h2>Chapter plan</h2>
						<p class="app-muted">
							Update output names and mark chapters to skip before export.
						</p>
						<div class="chapter-list stacked-list">
							{chapters.map((chapter) => (
								<article class="chapter-row stacked-item">
									<div class="chapter-header">
										<div>
											<h3>{chapter.title}</h3>
											<span class="chapter-time">
												{formatTimestamp(chapter.start)} -{' '}
												{formatTimestamp(chapter.end)}
											</span>
										</div>
										<span
											class={classNames(
												'status-pill',
												chapter.status === 'ready' && 'status-pill--success',
												chapter.status === 'review' && 'status-pill--warning',
												chapter.status === 'skipped' && 'status-pill--danger',
											)}
										>
											{chapter.status}
										</span>
									</div>
									<label class="input-label">
										Output file
										<input
											class="text-input"
											type="text"
											value={chapter.outputName}
											on={{
												input: (event) => {
													const target = event.currentTarget as HTMLInputElement
													updateChapterOutput(chapter.id, target.value)
												},
											}}
										/>
									</label>
									<label class="input-label">
										Status
										<select
											class="text-input"
											value={chapter.status}
											on={{
												change: (event) => {
													const target =
														event.currentTarget as HTMLSelectElement
													updateChapterStatus(
														chapter.id,
														target.value as ChapterStatus,
													)
												},
											}}
										>
											<option value="ready">ready</option>
											<option value="review">review</option>
											<option value="skipped">skipped</option>
										</select>
									</label>
									<p class="app-muted">{chapter.notes}</p>
								</article>
							))}
						</div>
					</section>

					<section class="app-card">
						<h2>Command windows</h2>
						<p class="app-muted">
							Apply Jarvis commands to your cut list or chapter metadata.
						</p>
						<div class="command-list stacked-list">
							{commands.map((command) => {
								const applied = isCommandApplied(command, sortedCuts, chapters)
								return (
									<article class="command-row stacked-item">
										<div class="command-header">
											<h3>{command.label}</h3>
											<span
												class={classNames(
													'status-pill',
													command.action === 'remove' && 'status-pill--danger',
													command.action === 'rename' && 'status-pill--info',
													command.action === 'skip' && 'status-pill--warning',
												)}
											>
												{command.action}
											</span>
										</div>
										<p class="app-muted">{command.summary}</p>
										<div class="command-meta">
											<span class="command-time">
												{formatTimestamp(command.start)} -{' '}
												{formatTimestamp(command.end)}
											</span>
											<button
												class="button button--ghost"
												type="button"
												disabled={applied}
												on={{ click: () => applyCommand(command) }}
											>
												{applied ? 'Applied' : 'Apply'}
											</button>
										</div>
									</article>
								)
							})}
						</div>
					</section>
				</div>

				<section class="app-card app-card--full transcript-card">
					<div class="transcript-header">
						<div>
							<h2>Transcript search</h2>
							<p class="app-muted">
								Search words and jump the playhead to review context.
							</p>
						</div>
						<div class="transcript-preview">
							<span class="summary-label">Playhead cue</span>
							<span class="summary-value">
								{currentWord ? formatTimestamp(currentWord.start) : '00:00.0'}
							</span>
							<span class="summary-subtext">{currentContext}</span>
						</div>
					</div>
					<label class="input-label">
						Search transcript
						<input
							class="text-input"
							type="search"
							placeholder="Search for a word or command marker"
							value={searchQuery}
							on={{
								input: (event) => {
									const target = event.currentTarget as HTMLInputElement
									updateSearchQuery(target.value)
								},
							}}
						/>
					</label>
					{query.length === 0 ? (
						<p class="app-muted transcript-empty">
							Type to search the transcript words. Click a result to jump to it.
						</p>
					) : searchResults.length === 0 ? (
						<p class="app-muted transcript-empty">
							No results found for "{query}".
						</p>
					) : (
						<ul class="transcript-results stacked-list">
							{searchResults.map((word) => (
								<li class="stacked-item">
									<button
										class="transcript-result"
										type="button"
										on={{ click: () => setPlayhead(word.start) }}
									>
										<span class="transcript-time">
											{formatTimestamp(word.start)}
										</span>
										<span class="transcript-snippet">{word.context}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</section>

				<section class="app-card app-card--full">
					<h2>CLI export preview</h2>
					<p class="app-muted">
						Use this command once you save your transcript edits.
					</p>
					<pre class="command-preview">{commandPreview}</pre>
				</section>
			</main>
		)
	}
}

function sortRanges(ranges: CutRange[]) {
	return ranges.slice().sort((a, b) => a.start - b.start)
}

function mergeOverlappingRanges(ranges: CutRange[]) {
	if (ranges.length === 0) return []
	const sorted = sortRanges(ranges)
	const merged: CutRange[] = [{ ...sorted[0] }]
	for (let i = 1; i < sorted.length; i++) {
		const current = sorted[i]
		const last = merged[merged.length - 1]
		if (current.start <= last.end) {
			last.end = Math.max(last.end, current.end)
		} else {
			merged.push({ ...current })
		}
	}
	return merged
}

function normalizeRange(range: CutRange, duration: number) {
	const start = clamp(range.start, 0, Math.max(duration - MIN_CUT_LENGTH, 0))
	const end = clamp(
		range.end,
		start + MIN_CUT_LENGTH,
		Math.max(duration, start + MIN_CUT_LENGTH),
	)
	return { ...range, start, end }
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max)
}

function formatTimestamp(value: number) {
	const clamped = Math.max(value, 0)
	const totalSeconds = Math.floor(clamped)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	const tenths = Math.floor((clamped - totalSeconds) * 10)
	return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`
}

function formatSeconds(value: number) {
	return `${value.toFixed(1)}s`
}

function formatProcessingCategory(category: ProcessingCategory) {
	if (category === 'chapter') return 'Chapter task'
	if (category === 'transcript') return 'Transcript task'
	return 'Export task'
}

function classNames(...values: Array<string | false | null | undefined>) {
	return values.filter(Boolean).join(' ')
}

function findWordAtTime(words: TranscriptWord[], time: number) {
	let current: TranscriptWord | null = null
	for (const word of words) {
		if (word.start <= time) {
			current = word
			continue
		}
		break
	}
	return current
}

function buildContext(words: TranscriptWord[], index: number, radius: number) {
	const start = Math.max(index - radius, 0)
	const end = Math.min(index + radius + 1, words.length)
	return words
		.slice(start, end)
		.map((word) => word.word)
		.join(' ')
}

function buildTimelineTicks(duration: number, count: number) {
	if (count <= 1) return [0]
	const step = duration / (count - 1)
	return Array.from({ length: count }, (_, index) =>
		Number((index * step).toFixed(1)),
	)
}

function buildCommandPreview(
	sourceName: string,
	chapters: ChapterPlan[],
	sourcePath?: string,
) {
	const outputName =
		chapters.find((chapter) => chapter.status !== 'skipped')?.outputName ??
		'edited-output.mp4'
	const inputPath =
		typeof sourcePath === 'string' && sourcePath.trim().length > 0
			? sourcePath
			: sourceName
	return [
		'bun process-course/edits/cli.ts edit-video \\',
		`  --input "${inputPath}" \\`,
		'  --transcript "transcript.json" \\',
		'  --edited "transcript.txt" \\',
		`  --output "${outputName}"`,
	].join('\n')
}

function findPreviousCut(cutRanges: CutRange[], playhead: number) {
	let previous: CutRange | null = null
	for (const range of cutRanges) {
		if (range.start < playhead) {
			previous = range
			continue
		}
		break
	}
	return previous
}

function isCommandApplied(
	command: CommandWindow,
	cutRanges: CutRange[],
	chapters: ChapterPlan[],
) {
	if (command.action === 'remove') {
		return cutRanges.some((range) => range.sourceId === command.id)
	}
	if (command.action === 'rename' && command.value) {
		return chapters.some(
			(chapter) =>
				chapter.id === command.chapterId &&
				chapter.outputName === command.value,
		)
	}
	if (command.action === 'skip') {
		return chapters.some(
			(chapter) =>
				chapter.id === command.chapterId && chapter.status === 'skipped',
		)
	}
	return false
}
