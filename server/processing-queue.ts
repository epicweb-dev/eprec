type ProcessingCategory = 'chapter' | 'transcript' | 'export'
type ProcessingStatus = 'queued' | 'running' | 'done' | 'error'
type ProcessingAction =
	| 'edit-chapter'
	| 'combine-chapters'
	| 'regenerate-transcript'
	| 'detect-command-windows'
	| 'render-preview'
	| 'export-final'

type ProcessingProgress = {
	step: number
	totalSteps: number
	label: string
	percent: number
}

export type ProcessingTask = {
	id: string
	title: string
	detail: string
	status: ProcessingStatus
	category: ProcessingCategory
	action: ProcessingAction
	progress?: ProcessingProgress
	errorMessage?: string
	updatedAt: number
	createdAt: number
	simulateError?: boolean
}

type ProcessingQueueSnapshot = {
	tasks: ProcessingTask[]
	activeTaskId: string | null
}

type QueueListener = (snapshot: ProcessingQueueSnapshot) => void

const QUEUE_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Accept, Content-Type',
} as const

const TASK_STEPS: Record<ProcessingAction, string[]> = {
	'edit-chapter': [
		'Collecting edit ranges',
		'Updating cut list',
		'Preparing edit workspace',
	],
	'combine-chapters': [
		'Loading chapter outputs',
		'Aligning audio padding',
		'Rendering combined preview',
	],
	'regenerate-transcript': [
		'Extracting audio',
		'Running Whisper alignment',
		'Refreshing transcript cues',
	],
	'detect-command-windows': [
		'Scanning transcript markers',
		'Refining command windows',
		'Updating cut ranges',
	],
	'render-preview': [
		'Rendering preview clip',
		'Optimizing output',
		'Verifying',
	],
	'export-final': [
		'Rendering chapters',
		'Packaging exports',
		'Verifying outputs',
	],
}

const STEP_DELAY_MS = 850
const STEP_JITTER_MS = 350

let tasks: ProcessingTask[] = []
let activeTaskId: string | null = null
let nextTaskId = 1
let runController: AbortController | null = null
const listeners = new Set<QueueListener>()

function buildSnapshot(): ProcessingQueueSnapshot {
	return {
		tasks,
		activeTaskId,
	}
}

function emitSnapshot() {
	const snapshot = buildSnapshot()
	for (const listener of listeners) {
		listener(snapshot)
	}
}

function updateQueueState(mutate: () => void) {
	mutate()
	emitSnapshot()
}

function updateTask(taskId: string, patch: Partial<ProcessingTask>) {
	updateQueueState(() => {
		tasks = tasks.map((task) =>
			task.id === taskId ? { ...task, ...patch, updatedAt: Date.now() } : task,
		)
	})
}

function enqueueTask(options: {
	title: string
	detail: string
	category: ProcessingCategory
	action: ProcessingAction
	simulateError?: boolean
}) {
	const task: ProcessingTask = {
		id: `task-${nextTaskId++}`,
		title: options.title,
		detail: options.detail,
		status: 'queued',
		category: options.category,
		action: options.action,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		simulateError: options.simulateError,
	}
	updateQueueState(() => {
		tasks = [...tasks, task]
	})
	return task
}

function removeTask(taskId: string) {
	updateQueueState(() => {
		tasks = tasks.filter((task) => task.id !== taskId)
		if (activeTaskId === taskId) {
			activeTaskId = null
			runController?.abort()
			runController = null
		}
	})
}

function clearCompleted() {
	updateQueueState(() => {
		tasks = tasks.filter((task) => task.status !== 'done')
	})
}

function markActiveDone() {
	if (!activeTaskId) return
	updateQueueState(() => {
		tasks = tasks.map((task) =>
			task.id === activeTaskId
				? {
						...task,
						status: 'done',
						progress: task.progress
							? { ...task.progress, percent: 100, label: 'Complete' }
							: undefined,
						updatedAt: Date.now(),
					}
				: task,
		)
		activeTaskId = null
		runController?.abort()
		runController = null
	})
}

function buildProgress(step: number, totalSteps: number, label: string) {
	const percent = totalSteps > 0 ? Math.round((step / totalSteps) * 100) : 0
	return { step, totalSteps, label, percent }
}

function sleep(duration: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(resolve, duration)
		const onAbort = () => {
			clearTimeout(timeout)
			reject(new Error('aborted'))
		}
		if (signal) {
			if (signal.aborted) {
				onAbort()
				return
			}
			signal.addEventListener('abort', onAbort, { once: true })
		}
	})
}

async function runTask(task: ProcessingTask) {
	const steps = TASK_STEPS[task.action] ?? ['Starting', 'Working', 'Complete']
	const controller = new AbortController()
	runController = controller
	updateQueueState(() => {
		activeTaskId = task.id
		tasks = tasks.map((entry) =>
			entry.id === task.id
				? {
						...entry,
						status: 'running',
						progress: buildProgress(0, steps.length, 'Starting'),
						errorMessage: undefined,
						updatedAt: Date.now(),
					}
				: entry,
		)
	})

	const failAtStep = task.simulateError
		? Math.max(1, Math.ceil(steps.length * 0.6))
		: null

	try {
		for (let index = 0; index < steps.length; index++) {
			if (controller.signal.aborted) return
			const label = steps[index]
			updateTask(task.id, {
				progress: buildProgress(index + 1, steps.length, label),
			})
			if (failAtStep && index + 1 === failAtStep) {
				throw new Error('Processing failed during render.')
			}
			const delay = STEP_DELAY_MS + Math.round(Math.random() * STEP_JITTER_MS)
			await sleep(delay, controller.signal)
		}
		updateTask(task.id, {
			status: 'done',
			progress: buildProgress(steps.length, steps.length, 'Complete'),
		})
	} catch (error) {
		if (controller.signal.aborted) return
		updateTask(task.id, {
			status: 'error',
			errorMessage:
				error instanceof Error ? error.message : 'Processing failed.',
		})
	} finally {
		runController = null
		updateQueueState(() => {
			if (activeTaskId === task.id) {
				activeTaskId = null
			}
		})
	}
}

function runNextTask() {
	if (activeTaskId) return
	const nextTask = tasks.find((task) => task.status === 'queued')
	if (!nextTask) return
	void runTask(nextTask)
}

function jsonResponse(payload: unknown, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...QUEUE_HEADERS,
		},
	})
}

function createEventStream(request: Request) {
	const encoder = new TextEncoder()
	return new Response(
		new ReadableStream({
			start(controller) {
				let isClosed = false
				const send = (event: string, data: unknown) => {
					if (isClosed) return
					controller.enqueue(
						encoder.encode(
							`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
						),
					)
				}
				const listener = (snapshot: ProcessingQueueSnapshot) => {
					send('snapshot', snapshot)
				}
				listeners.add(listener)
				send('snapshot', buildSnapshot())
				const ping = setInterval(() => {
					send('ping', { time: Date.now() })
				}, 15000)
				const close = () => {
					if (isClosed) return
					isClosed = true
					clearInterval(ping)
					listeners.delete(listener)
					controller.close()
				}
				request.signal.addEventListener('abort', close)
			},
			cancel() {
				// handled via abort
			},
		}),
		{
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-transform',
				Connection: 'keep-alive',
				...QUEUE_HEADERS,
			},
		},
	)
}

function isProcessingCategory(value: unknown): value is ProcessingCategory {
	return value === 'chapter' || value === 'transcript' || value === 'export'
}

function isProcessingAction(value: unknown): value is ProcessingAction {
	return (
		value === 'edit-chapter' ||
		value === 'combine-chapters' ||
		value === 'regenerate-transcript' ||
		value === 'detect-command-windows' ||
		value === 'render-preview' ||
		value === 'export-final'
	)
}

export async function handleProcessingQueueRequest(request: Request) {
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: QUEUE_HEADERS })
	}

	const url = new URL(request.url)
	const pathname = url.pathname

	if (pathname === '/api/processing-queue/stream') {
		if (request.method !== 'GET') {
			return jsonResponse({ error: 'Method not allowed' }, 405)
		}
		return createEventStream(request)
	}

	if (pathname === '/api/processing-queue') {
		if (request.method !== 'GET') {
			return jsonResponse({ error: 'Method not allowed' }, 405)
		}
		return jsonResponse(buildSnapshot())
	}

	if (pathname === '/api/processing-queue/enqueue') {
		if (request.method !== 'POST') {
			return jsonResponse({ error: 'Method not allowed' }, 405)
		}
		let payload: unknown = null
		try {
			payload = await request.json()
		} catch (error) {
			return jsonResponse({ error: 'Invalid JSON payload.' }, 400)
		}
		if (
			!payload ||
			typeof payload !== 'object' ||
			!('title' in payload) ||
			!('detail' in payload) ||
			!('category' in payload) ||
			!('action' in payload)
		) {
			return jsonResponse({ error: 'Missing task fields.' }, 400)
		}
		const data = payload as {
			title?: unknown
			detail?: unknown
			category?: unknown
			action?: unknown
			simulateError?: unknown
		}
		if (typeof data.title !== 'string' || data.title.trim().length === 0) {
			return jsonResponse({ error: 'Task title is required.' }, 400)
		}
		if (typeof data.detail !== 'string') {
			return jsonResponse({ error: 'Task detail is required.' }, 400)
		}
		if (!isProcessingCategory(data.category)) {
			return jsonResponse({ error: 'Invalid task category.' }, 400)
		}
		if (!isProcessingAction(data.action)) {
			return jsonResponse({ error: 'Invalid task action.' }, 400)
		}
		enqueueTask({
			title: data.title,
			detail: data.detail,
			category: data.category,
			action: data.action,
			simulateError: data.simulateError === true,
		})
		return jsonResponse(buildSnapshot())
	}

	if (pathname === '/api/processing-queue/run-next') {
		if (request.method !== 'POST') {
			return jsonResponse({ error: 'Method not allowed' }, 405)
		}
		runNextTask()
		return jsonResponse(buildSnapshot())
	}

	if (pathname === '/api/processing-queue/mark-done') {
		if (request.method !== 'POST') {
			return jsonResponse({ error: 'Method not allowed' }, 405)
		}
		markActiveDone()
		return jsonResponse(buildSnapshot())
	}

	if (pathname === '/api/processing-queue/clear-completed') {
		if (request.method !== 'POST') {
			return jsonResponse({ error: 'Method not allowed' }, 405)
		}
		clearCompleted()
		return jsonResponse(buildSnapshot())
	}

	if (pathname.startsWith('/api/processing-queue/task/')) {
		if (request.method !== 'DELETE') {
			return jsonResponse({ error: 'Method not allowed' }, 405)
		}
		const taskId = pathname.replace('/api/processing-queue/task/', '')
		if (!taskId) {
			return jsonResponse({ error: 'Task id is required.' }, 400)
		}
		removeTask(taskId)
		return jsonResponse(buildSnapshot())
	}

	return jsonResponse({ error: 'Not found' }, 404)
}
