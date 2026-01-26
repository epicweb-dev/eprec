import { test, expect } from 'bun:test'
import { createShortcutInputHandler } from './app-server'

type ShortcutCounts = {
	open: number
	restart: number
	stop: number
	help: number
	spacing: number
}

function createShortcutCounts(): ShortcutCounts {
	return {
		open: 0,
		restart: 0,
		stop: 0,
		help: 0,
		spacing: 0,
	}
}

function createShortcutHandler() {
	const counts = createShortcutCounts()
	const handler = createShortcutInputHandler({
		open: () => {
			counts.open += 1
		},
		restart: () => {
			counts.restart += 1
		},
		stop: () => {
			counts.stop += 1
		},
		help: () => {
			counts.help += 1
		},
		spacing: () => {
			counts.spacing += 1
		},
	})

	return { counts, handler }
}

test('createShortcutInputHandler adds spacing for enter key', () => {
	const { counts, handler } = createShortcutHandler()

	handler.handleInput('\r')

	expect(counts.spacing).toBe(1)
})

test('createShortcutInputHandler ignores linefeed after carriage return', () => {
	const { counts, handler } = createShortcutHandler()

	handler.handleInput('\r\n')

	expect(counts.spacing).toBe(1)
})

test('createShortcutInputHandler maps shortcuts case-insensitively', () => {
	const { counts, handler } = createShortcutHandler()

	handler.handleInput('OrQh?')

	expect(counts.open).toBe(1)
	expect(counts.restart).toBe(1)
	expect(counts.stop).toBe(1)
	expect(counts.help).toBe(2)
})
