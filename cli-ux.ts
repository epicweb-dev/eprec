import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import searchPrompt from '@inquirer/search'
import inquirer from 'inquirer'
import ora, { type Ora } from 'ora'

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
			const { result } = await inquirer.prompt<{ result: T }>([
				{
					type: 'list',
					name: 'result',
					message,
					choices,
				},
			])
			return result
		},
		async search<T>(message: string, choices: PromptChoice<T>[]) {
			const result = await searchPrompt<T>({
				message,
				source: async (input) => filterPromptChoices(choices, input),
			})
			return result
		},
		async input(
			message: string,
			options?: {
				defaultValue?: string
				validate?: (value: string) => true | string | Promise<true | string>
			},
		) {
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
		},
		async confirm(message: string, options?: { defaultValue?: boolean }) {
			const { result } = await inquirer.prompt<{ result: boolean }>([
				{
					type: 'confirm',
					name: 'result',
					message,
					default: options?.defaultValue ?? false,
				},
			])
			return result
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

function normalizeSearchValue(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function buildChoiceSearchText(choice: PromptChoice<unknown>) {
	const parts = [
		choice.name,
		choice.short,
		choice.description,
		typeof choice.value === 'string' ? choice.value : '',
		...(choice.keywords ?? []),
	].filter(Boolean)
	return normalizeSearchValue(parts.join(' '))
}

function filterPromptChoices<T>(choices: PromptChoice<T>[], input?: string) {
	const query = normalizeSearchValue(input ?? '')
	if (!query) {
		return choices
	}
	const tokens = query.split(' ').filter(Boolean)
	return choices.filter((choice) => {
		const haystack = buildChoiceSearchText(choice)
		return tokens.every((token) => haystack.includes(token))
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
		const selection = await prompter.select(
			`${options.message} (${currentDir})`,
			choices,
		)
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
