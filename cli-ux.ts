import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import searchPrompt from '@inquirer/search'
import { matchSorter } from 'match-sorter'
import inquirer from 'inquirer'
import ora, { type Ora } from 'ora'
import type { StepProgressReporter } from './progress-reporter'

export type PromptChoice<T> = {
	name: string
	value: T
	short?: string
	description?: string
	keywords?: string[]
}

export type Prompter = {
	select<T>(message: string, choices: PromptChoice<T>[]): Promise<T>
	search<T>(message: string, choices: PromptChoice<T>[]): Promise<T>
	input(
		message: string,
		options?: {
			defaultValue?: string
			validate?: (value: string) => true | string | Promise<true | string>
		},
	): Promise<string>
	confirm(
		message: string,
		options?: { defaultValue?: boolean },
	): Promise<boolean>
}

export type PathPicker = {
	pickExistingFile(options: {
		message: string
		startDir?: string
		extensions?: string[]
	}): Promise<string>
	pickExistingDirectory(options: {
		message: string
		startDir?: string
	}): Promise<string>
	pickOutputPath(options: {
		message: string
		startDir?: string
		defaultPath?: string
	}): Promise<string>
}

export class PromptCancelled extends Error {
	constructor(message = 'Prompt cancelled.') {
		super(message)
		this.name = 'PromptCancelled'
	}
}

function isExitPromptError(error: unknown) {
	if (error instanceof Error) {
		return (
			error.name === 'ExitPromptError' ||
			error.message.includes('User force closed the prompt')
		)
	}
	if (error && typeof error === 'object' && 'name' in error) {
		return (error as { name?: unknown }).name === 'ExitPromptError'
	}
	return false
}

function handlePromptError(error: unknown): never {
	if (error instanceof PromptCancelled) {
		throw error
	}
	if (isExitPromptError(error)) {
		throw new PromptCancelled()
	}
	throw error
}

async function runPrompt<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action()
	} catch (error) {
		return handlePromptError(error)
	}
}

export function resolveOptionalString(value: unknown) {
	if (typeof value !== 'string') {
		return undefined
	}
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

export function isInteractive() {
	if (process.env.EPREC_FORCE_INTERACTIVE === '1') {
		return true
	}
	if (process.env.CI) {
		return false
	}
	return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

let activeSpinner: Ora | null = null

export function pauseActiveSpinner() {
	if (activeSpinner?.isSpinning) {
		activeSpinner.stop()
	}
}

export function resumeActiveSpinner() {
	if (activeSpinner && !activeSpinner.isSpinning) {
		activeSpinner.start()
	}
}

export function setActiveSpinnerText(text: string) {
	if (activeSpinner) {
		activeSpinner.text = text
	}
}

const STEP_PROGRESS_BAR_WIDTH = 12
const STEP_PROGRESS_LABEL_MAX = 32
const STEP_PROGRESS_DETAIL_MAX = 26
const STEP_PROGRESS_ACTION_MAX = 24

function clampProgress(value: number) {
	return Math.max(0, Math.min(1, value))
}

function formatPercent(value: number) {
	return `${Math.round(clampProgress(value) * 100)}%`
}

function formatProgressBar(value: number, width = STEP_PROGRESS_BAR_WIDTH) {
	const clamped = clampProgress(value)
	const filled = Math.round(clamped * width)
	return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`
}

function truncateLabel(value: string, maxLength: number) {
	const trimmed = value.trim()
	if (trimmed.length <= maxLength) {
		return trimmed
	}
	return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`
}

export function createStepProgressReporter(options: {
	action: string
	detail?: string
	maxLabelLength?: number
}): StepProgressReporter {
	let stepIndex = 0
	let stepCount = 1
	let stepLabel = 'Starting'
	const actionLabel = truncateLabel(options.action, STEP_PROGRESS_ACTION_MAX)

	const update = () => {
		const progress = stepCount > 0 ? stepIndex / stepCount : 0
		const detail = options.detail
			? ` | ${truncateLabel(options.detail, STEP_PROGRESS_DETAIL_MAX)}`
			: ''
		const label = truncateLabel(
			stepLabel,
			options.maxLabelLength ?? STEP_PROGRESS_LABEL_MAX,
		)
		setActiveSpinnerText(
			`${actionLabel}${detail} | ${formatPercent(progress)} ${formatProgressBar(progress)} | ${label || 'Working'}`,
		)
	}

	return {
		start({ stepCount: initialCount, label }) {
			stepCount = Math.max(1, Math.round(initialCount))
			stepIndex = 0
			stepLabel = label ?? 'Starting'
			update()
		},
		step(label) {
			stepCount = Math.max(1, Math.round(stepCount))
			stepIndex = Math.min(stepIndex + 1, stepCount)
			stepLabel = label
			update()
		},
		setLabel(label) {
			stepLabel = label
			update()
		},
		finish(label) {
			stepCount = Math.max(1, Math.round(stepCount))
			stepIndex = stepCount
			stepLabel = label ?? 'Complete'
			update()
		},
	}
}

export async function withSpinner<T>(
	text: string,
	action: () => Promise<T>,
	options?: {
		successText?: string
		failText?: string
		enabled?: boolean
	},
): Promise<T> {
	const enabled = options?.enabled ?? isInteractive()
	if (!enabled) {
		return action()
	}
	const spinner = ora({ text }).start()
	activeSpinner = spinner
	try {
		const result = await action()
		spinner.succeed(options?.successText ?? `${text} done`)
		return result
	} catch (error) {
		spinner.fail(options?.failText ?? `${text} failed`)
		throw error
	} finally {
		if (activeSpinner === spinner) {
			activeSpinner = null
		}
	}
}

export function createInquirerPrompter(): Prompter {
	return {
		async select<T>(message: string, choices: PromptChoice<T>[]) {
			return runPrompt(async () => {
				const { result } = await inquirer.prompt<{ result: T }>([
					{
						type: 'list',
						name: 'result',
						message,
						choices,
					},
				])
				return result
			})
		},
		async search<T>(message: string, choices: PromptChoice<T>[]) {
			return runPrompt(() =>
				searchPrompt<T>({
					message,
					source: async (input) => filterPromptChoices(choices, input),
				}),
			)
		},
		async input(
			message: string,
			options?: {
				defaultValue?: string
				validate?: (value: string) => true | string | Promise<true | string>
			},
		) {
			return runPrompt(async () => {
				const { result } = await inquirer.prompt<{ result: string }>([
					{
						type: 'input',
						name: 'result',
						message,
						default: options?.defaultValue,
						validate: options?.validate,
					},
				])
				return result
			})
		},
		async confirm(message: string, options?: { defaultValue?: boolean }) {
			return runPrompt(async () => {
				const { result } = await inquirer.prompt<{ result: boolean }>([
					{
						type: 'confirm',
						name: 'result',
						message,
						default: options?.defaultValue ?? false,
					},
				])
				return result
			})
		},
	}
}

type FileExplorerChoice =
	| { kind: 'up' }
	| { kind: 'manual' }
	| { kind: 'cancel' }
	| { kind: 'dir'; path: string }
	| { kind: 'file'; path: string }
	| { kind: 'select-dir'; path: string }

const DEFAULT_IGNORED_DIRS = new Set(['node_modules', '.git', '.cache'])

export function createPathPicker(prompter: Prompter): PathPicker {
	let lastDir: string | undefined
	return {
		async pickExistingFile(options) {
			const selectedPath = await promptForPath(prompter, {
				kind: 'file',
				message: options.message,
				startDir: options.startDir ?? lastDir,
				extensions: options.extensions,
			})
			lastDir = path.dirname(selectedPath)
			return selectedPath
		},
		async pickExistingDirectory(options) {
			const selectedPath = await promptForPath(prompter, {
				kind: 'directory',
				message: options.message,
				startDir: options.startDir ?? lastDir,
			})
			lastDir = selectedPath
			return selectedPath
		},
		async pickOutputPath(options) {
			const defaultPath = options.defaultPath
				? path.resolve(options.defaultPath)
				: undefined
			const response = await prompter.select('Output path', [
				{ name: 'Use file explorer', value: 'explorer' },
				{ name: 'Enter path manually', value: 'manual' },
				{ name: 'Cancel', value: 'cancel' },
			])
			if (response === 'cancel') {
				throw new PromptCancelled()
			}
			if (response === 'manual') {
				const manualPath = await prompter.input(options.message, {
					defaultValue: defaultPath,
					validate: (value) =>
						resolveOptionalString(value) ? true : 'Enter a file path.',
				})
				const resolved = path.resolve(manualPath)
				lastDir = path.dirname(resolved)
				return resolved
			}
			const startDir =
				options.startDir ??
				lastDir ??
				(defaultPath ? path.dirname(defaultPath) : process.cwd())
			const directory = await promptForPath(prompter, {
				kind: 'directory',
				message: 'Select output directory',
				startDir,
			})
			const defaultName = defaultPath ? path.basename(defaultPath) : undefined
			const fileName = await prompter.input('Output file name', {
				defaultValue: defaultName,
				validate: validateFileName,
			})
			const outputPath = path.join(directory, fileName)
			lastDir = directory
			return outputPath
		},
	}
}

function buildChoiceSearchText(choice: PromptChoice<unknown>) {
	const parts = [
		choice.name,
		choice.short,
		choice.description,
		typeof choice.value === 'string' ? choice.value : '',
		...(choice.keywords ?? []),
	].filter(Boolean)
	return parts.join(' ')
}

function filterPromptChoices<T>(choices: PromptChoice<T>[], input?: string) {
	const query = input?.trim() ?? ''
	if (query.length === 0) {
		return choices
	}
	return matchSorter(choices, query, {
		keys: [(choice) => buildChoiceSearchText(choice)],
	})
}

function validateFileName(value: string) {
	const trimmed = value.trim()
	if (!trimmed) {
		return 'Enter a file name.'
	}
	if (trimmed.includes(path.sep) || trimmed.includes('/')) {
		return 'Enter a file name without directories.'
	}
	return true
}

async function promptForPath(
	prompter: Prompter,
	options: {
		kind: 'file' | 'directory'
		message: string
		startDir?: string
		extensions?: string[]
	},
): Promise<string> {
	let currentDir = await resolveStartDir(options.startDir)
	while (true) {
		const choices = await buildExplorerChoices(currentDir, options)
		const rawSelection = (await prompter.select(
			`${options.message} (${currentDir})`,
			choices,
		)) as FileExplorerChoice | string
		const selection = resolveExplorerSelection(rawSelection, choices)
		if (!selection) {
			continue
		}
		switch (selection.kind) {
			case 'up':
				currentDir = path.dirname(currentDir)
				break
			case 'dir':
				currentDir = selection.path
				break
			case 'select-dir':
				return selection.path
			case 'file':
				return selection.path
			case 'manual': {
				const resolved = await promptForManualPath(
					prompter,
					options,
					currentDir,
				)
				if (resolved) {
					return resolved
				}
				break
			}
			case 'cancel':
				throw new PromptCancelled()
		}
	}
}

async function resolveStartDir(startDir?: string) {
	const candidate = startDir ?? process.cwd()
	try {
		const stats = await stat(candidate)
		if (stats.isDirectory()) {
			return candidate
		}
		if (stats.isFile()) {
			return path.dirname(candidate)
		}
	} catch {
		return process.cwd()
	}
	return process.cwd()
}

async function promptForManualPath(
	prompter: Prompter,
	options: { kind: 'file' | 'directory' },
	currentDir: string,
) {
	const manual = await prompter.input('Enter path manually', {
		validate: async (value) =>
			validateManualPath(value, options.kind, currentDir),
	})
	const resolved = resolveManualPath(manual.trim(), currentDir)
	return resolved
}

function resolveManualPath(value: string, currentDir: string) {
	return path.isAbsolute(value) ? value : path.resolve(currentDir, value)
}

async function validateManualPath(
	value: string,
	kind: 'file' | 'directory',
	currentDir: string,
) {
	const trimmed = resolveOptionalString(value)
	if (!trimmed) {
		return 'Enter a path.'
	}
	const resolved = resolveManualPath(trimmed, currentDir)
	try {
		const stats = await stat(resolved)
		if (kind === 'file' && !stats.isFile()) {
			return 'Select a file path.'
		}
		if (kind === 'directory' && !stats.isDirectory()) {
			return 'Select a directory path.'
		}
		return true
	} catch {
		return `Path not found: ${resolved}`
	}
}

async function buildExplorerChoices(
	currentDir: string,
	options: {
		kind: 'file' | 'directory'
		extensions?: string[]
	},
): Promise<PromptChoice<FileExplorerChoice>[]> {
	const entries = await listEntries(currentDir)
	const choices: PromptChoice<FileExplorerChoice>[] = []
	const parent = path.dirname(currentDir)
	if (parent !== currentDir) {
		choices.push({ name: '../ (up)', value: { kind: 'up' } })
	}
	if (options.kind === 'directory') {
		choices.push({
			name: './ (select this directory)',
			value: { kind: 'select-dir', path: currentDir },
		})
	}
	for (const entry of entries.directories) {
		choices.push({
			name: `${entry.name}/`,
			value: { kind: 'dir', path: entry.path },
		})
	}
	if (options.kind === 'file') {
		for (const entry of entries.files) {
			if (!matchesExtensions(entry.name, options.extensions)) {
				continue
			}
			choices.push({
				name: entry.name,
				value: { kind: 'file', path: entry.path },
			})
		}
	}
	choices.push({ name: 'Enter path manually', value: { kind: 'manual' } })
	choices.push({ name: 'Cancel', value: { kind: 'cancel' } })
	return choices
}

function resolveExplorerSelection(
	selection: FileExplorerChoice | string,
	choices: PromptChoice<FileExplorerChoice>[],
) {
	if (typeof selection !== 'string') {
		return selection
	}
	const matched = choices.find((choice) => {
		if (choice.name === selection) {
			return true
		}
		const value = choice.value
		if (value && typeof value === 'object' && 'path' in value) {
			return value.path === selection
		}
		return false
	})
	return matched?.value ?? null
}

function matchesExtensions(name: string, extensions?: string[]) {
	if (!extensions || extensions.length === 0) {
		return true
	}
	const lower = name.toLowerCase()
	return extensions.some((extension) => lower.endsWith(extension.toLowerCase()))
}

async function listEntries(currentDir: string) {
	const dirEntries = await readdir(currentDir, { withFileTypes: true })
	const directories = dirEntries
		.filter((entry) => entry.isDirectory())
		.filter((entry) => !DEFAULT_IGNORED_DIRS.has(entry.name))
		.map((entry) => ({
			name: entry.name,
			path: path.join(currentDir, entry.name),
		}))
	const files = dirEntries
		.filter((entry) => entry.isFile())
		.map((entry) => ({
			name: entry.name,
			path: path.join(currentDir, entry.name),
		}))
	directories.sort((a, b) => a.name.localeCompare(b.name))
	files.sort((a, b) => a.name.localeCompare(b.name))
	return { directories, files }
}
