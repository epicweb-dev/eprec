import type { Handle } from 'remix/component'
import {
	sampleEditSession,
	type ChapterPlan,
	type ChapterStatus,
	type CommandWindow,
	type CutRange,
	type TranscriptWord,
} from './edit-session-data.ts'
import { StyleSystemSample } from '../components/style-system-sample.tsx'

const MIN_CUT_LENGTH = 0.2
const DEFAULT_CUT_LENGTH = 2.4
const PLAYHEAD_STEP = 0.1

export function EditingWorkspace(handle: Handle) {
	const duration = sampleEditSession.duration
	const transcript = sampleEditSession.transcript
	const commands = sampleEditSession.commands
	let cutRanges = sampleEditSession.cuts.map((range) => ({ ...range }))
	let chapters = sampleEditSession.chapters.map((chapter) => ({ ...chapter }))
	let playhead = 18.2
	let selectedRangeId = cutRanges[0]?.id ?? null
	let searchQuery = ''
	let manualCutId = 1
	let previewDuration = 0
	let previewReady = false
	let previewPlaying = false
	let previewNode: HTMLVideoElement | null = null
	let lastSyncedPlayhead = playhead

	const setPlayhead = (value: number) => {
		playhead = clamp(value, 0, duration)
		syncVideoToPlayhead(playhead)
		handle.update()
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
		const query = searchQuery.trim().toLowerCase()
		const searchResults = query
			? transcript
					.filter((word) => word.word.toLowerCase().includes(query))
					.slice(0, 12)
			: []
		const commandPreview = buildCommandPreview(
			sampleEditSession.sourceName,
			chapters,
		)
		const previewTime =
			previewReady && previewDuration > 0
				? (playhead / duration) * previewDuration
				: 0

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

				<StyleSystemSample />

				<section class="app-card app-card--full">
					<h2>Session summary</h2>
					<div class="summary-grid">
						<div class="summary-item">
							<span class="summary-label">Source video</span>
							<span class="summary-value">{sampleEditSession.sourceName}</span>
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
										class={classNames(
											'status-pill',
											previewReady
												? previewPlaying
													? 'status-pill--info'
													: 'status-pill--success'
												: 'status-pill--warning',
										)}
									>
										{previewReady
											? previewPlaying
												? 'Playing'
												: 'Ready'
											: 'Loading'}
									</span>
								</div>
								<video
									class="timeline-video-player"
									src="/e2e-test.mp4"
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
											syncVideoToPlayhead(playhead)
											handle.update()
										}
										const handleTimeUpdate = () => {
											if (!previewReady || previewDuration <= 0) return
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
										node.addEventListener(
											'loadedmetadata',
											handleLoadedMetadata,
										)
										node.addEventListener('timeupdate', handleTimeUpdate)
										node.addEventListener('play', handlePlay)
										node.addEventListener('pause', handlePause)
										signal.addEventListener('abort', () => {
											node.removeEventListener(
												'loadedmetadata',
												handleLoadedMetadata,
											)
											node.removeEventListener('timeupdate', handleTimeUpdate)
											node.removeEventListener('play', handlePlay)
											node.removeEventListener('pause', handlePause)
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
											setPlayhead(Number(target.value))
										},
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
							<ul class="cut-list">
								{sortedCuts.map((range) => (
									<li
										class={classNames(
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
						<div class="chapter-list">
							{chapters.map((chapter) => (
								<article class="chapter-row">
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
						<div class="command-list">
							{commands.map((command) => {
								const applied = isCommandApplied(command, sortedCuts, chapters)
								return (
									<article class="command-row">
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
					) : (
						<ul class="transcript-results">
							{searchResults.map((word) => (
								<li>
									<button
										class="transcript-result"
										type="button"
										on={{ click: () => setPlayhead(word.start) }}
									>
										<span class="transcript-time">
											{formatTimestamp(word.start)}
										</span>
										<span class="transcript-snippet">
											{buildContext(transcript, word.index, 3)}
										</span>
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

function buildCommandPreview(sourceName: string, chapters: ChapterPlan[]) {
	const outputName =
		chapters.find((chapter) => chapter.status !== 'skipped')?.outputName ??
		'edited-output.mp4'
	return [
		'bun process-course/edits/cli.ts edit-video \\',
		`  --input "${sourceName}" \\`,
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
