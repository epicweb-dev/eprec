import { test, expect } from 'bun:test'
import {
	clamp,
	formatCommand,
	formatSeconds,
	normalizeFilename,
	runCommand,
	toKebabCase,
} from './utils'

test('formatCommand quotes parts that include spaces', () => {
	expect(formatCommand(['ffmpeg', '-i', 'my file.mp4'])).toBe(
		'ffmpeg -i "my file.mp4"',
	)
})

test('formatCommand keeps parts without spaces unchanged', () => {
	expect(formatCommand(['echo', 'hello'])).toBe('echo hello')
})

test('formatSeconds formats to two decimals with suffix', () => {
	expect(formatSeconds(1)).toBe('1.00s')
	expect(formatSeconds(1.234)).toBe('1.23s')
})

test('clamp keeps values within range', () => {
	expect(clamp(5, 0, 10)).toBe(5)
})

test('clamp enforces minimum bound', () => {
	expect(clamp(-2, 0, 10)).toBe(0)
})

test('clamp enforces maximum bound', () => {
	expect(clamp(12, 0, 10)).toBe(10)
})

test('toKebabCase trims, lowercases, and removes punctuation', () => {
	expect(toKebabCase('Hello, World!')).toBe('hello-world')
})

test('toKebabCase collapses repeated separators', () => {
	expect(toKebabCase('  React   Hooks  ')).toBe('react-hooks')
})

test('toKebabCase returns untitled for empty input', () => {
	expect(toKebabCase('   ')).toBe('untitled')
})

test('normalizeFilename converts number words and dots', () => {
	expect(normalizeFilename('Lesson One point Five')).toBe('lesson 01.05')
})

test('normalizeFilename trims and lowercases', () => {
	expect(normalizeFilename('  Intro  ')).toBe('intro')
})

test('runCommand captures stdout for successful command', async () => {
	const result = await runCommand(['echo', 'hello'])
	expect(result.exitCode).toBe(0)
	expect(result.stdout.trim()).toBe('hello')
})

test('runCommand throws on non-zero exit without allowFailure', async () => {
	await expect(runCommand(['false'])).rejects.toThrow('Command failed')
})

test('runCommand returns exit code when allowFailure is true', async () => {
	const result = await runCommand(['false'], { allowFailure: true })
	expect(result.exitCode).toBe(1)
})
