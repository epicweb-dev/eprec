import { test, expect } from 'bun:test'
import { scaleTranscriptSegments, extractTranscriptCommands } from './parser'
import type { TranscriptSegment } from '../../whispercpp-transcribe'

// Factory functions for test data
function createSegment(
	start: number,
	end: number,
	text: string,
): TranscriptSegment {
	return { start, end, text }
}

function createSegments(
	...entries: Array<[number, number, string]>
): TranscriptSegment[] {
	return entries.map(([start, end, text]) => createSegment(start, end, text))
}

const defaultOptions = { wakeWord: 'jarvis', closeWord: 'thanks' }

// scaleTranscriptSegments - no scaling needed
test('scaleTranscriptSegments returns empty array for empty input', () => {
	expect(scaleTranscriptSegments([], 100)).toEqual([])
})

test('scaleTranscriptSegments returns unchanged when max end matches duration', () => {
	const segments = createSegments([0, 50, 'Hello'], [50, 100, 'world'])
	expect(scaleTranscriptSegments(segments, 100)).toEqual(segments)
})

test('scaleTranscriptSegments returns unchanged within 2% tolerance', () => {
	const segments = createSegments([0, 50, 'Hello'], [50, 99, 'world'])
	expect(scaleTranscriptSegments(segments, 100)).toEqual(segments)
})

// scaleTranscriptSegments - scaling applied
test('scaleTranscriptSegments scales up when transcript shorter than duration', () => {
	const segments = createSegments([0, 25, 'Hello'], [25, 50, 'world'])
	const result = scaleTranscriptSegments(segments, 100)
	expect(result).toEqual(createSegments([0, 50, 'Hello'], [50, 100, 'world']))
})

test('scaleTranscriptSegments scales down when transcript longer than duration', () => {
	const segments = createSegments([0, 100, 'Hello'], [100, 200, 'world'])
	const result = scaleTranscriptSegments(segments, 100)
	expect(result).toEqual(createSegments([0, 50, 'Hello'], [50, 100, 'world']))
})

test('scaleTranscriptSegments preserves text when scaling', () => {
	const segments = createSegments([0, 50, 'Hello world'])
	const result = scaleTranscriptSegments(segments, 100)
	expect(result[0]?.text).toBe('Hello world')
})

// scaleTranscriptSegments - edge cases
test('scaleTranscriptSegments returns unchanged for zero duration', () => {
	const segments = createSegments([0, 50, 'Hello'])
	expect(scaleTranscriptSegments(segments, 0)).toEqual(segments)
})

test('scaleTranscriptSegments returns unchanged for negative duration', () => {
	const segments = createSegments([0, 50, 'Hello'])
	expect(scaleTranscriptSegments(segments, -100)).toEqual(segments)
})

test('scaleTranscriptSegments returns unchanged for NaN duration', () => {
	const segments = createSegments([0, 50, 'Hello'])
	expect(scaleTranscriptSegments(segments, NaN)).toEqual(segments)
})

test('scaleTranscriptSegments returns unchanged for Infinity duration', () => {
	const segments = createSegments([0, 50, 'Hello'])
	expect(scaleTranscriptSegments(segments, Infinity)).toEqual(segments)
})

test('scaleTranscriptSegments returns unchanged when all segments have zero end', () => {
	const segments = createSegments([0, 0, 'Hello'])
	expect(scaleTranscriptSegments(segments, 100)).toEqual(segments)
})

test('scaleTranscriptSegments uses alphanumeric candidates for max end', () => {
	const segments = createSegments([0, 50, 'Hello'], [50, 100, '...'])
	const result = scaleTranscriptSegments(segments, 100)
	expect(result[0]).toEqual(createSegment(0, 100, 'Hello'))
	expect(result[1]).toEqual(createSegment(100, 200, '...'))
})

test('scaleTranscriptSegments falls back to all segments when no alphanumeric', () => {
	const segments = createSegments([0, 25, '...'], [25, 50, '!!!'])
	const result = scaleTranscriptSegments(segments, 100)
	expect(result).toEqual(createSegments([0, 50, '...'], [50, 100, '!!!']))
})

// extractTranscriptCommands - bad-take
test('extractTranscriptCommands extracts bad-take command', () => {
	const segments = createSegments([0, 2, 'Jarvis bad take thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]).toEqual({
		type: 'bad-take',
		window: { start: 0, end: 2 },
	})
})

test('extractTranscriptCommands extracts bad-take from badtake as one word', () => {
	const segments = createSegments([0, 2, 'Jarvis badtake thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('bad-take')
})

test('extractTranscriptCommands extracts bad-take from Jervis (corrected)', () => {
	const segments = createSegments([0, 2, 'Jervis bad take thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('bad-take')
})

// extractTranscriptCommands - filename
test('extractTranscriptCommands extracts filename command with value', () => {
	const segments = createSegments([
		0,
		3,
		'Jarvis filename intro to react thanks',
	])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]).toEqual({
		type: 'filename',
		value: 'intro to react',
		window: { start: 0, end: 3 },
	})
})

test('extractTranscriptCommands extracts filename with file name as two words', () => {
	const segments = createSegments([
		0,
		3,
		'Jarvis file name hooks tutorial thanks',
	])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('filename')
	expect(commands[0]?.value).toBe('hooks tutorial')
})

test('extractTranscriptCommands ignores filename without value', () => {
	const segments = createSegments([0, 2, 'Jarvis filename thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(0)
})

test('extractTranscriptCommands ignores file name without value', () => {
	const segments = createSegments([0, 2, 'Jarvis file name thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(0)
})

// extractTranscriptCommands - edit
test('extractTranscriptCommands extracts edit command', () => {
	const segments = createSegments([0, 2, 'Jarvis edit thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]).toEqual({
		type: 'edit',
		window: { start: 0, end: 2 },
	})
})

// extractTranscriptCommands - note
test('extractTranscriptCommands extracts note command with value', () => {
	const segments = createSegments([
		0,
		3,
		'Jarvis note add more examples thanks',
	])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]).toEqual({
		type: 'note',
		value: 'add more examples',
		window: { start: 0, end: 3 },
	})
})

test('extractTranscriptCommands ignores note without value', () => {
	const segments = createSegments([0, 2, 'Jarvis note thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(0)
})

// extractTranscriptCommands - split
test('extractTranscriptCommands extracts split command', () => {
	const segments = createSegments([0, 2, 'Jarvis split thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('split')
})

test('extractTranscriptCommands extracts new chapter as split', () => {
	const segments = createSegments([0, 3, 'Jarvis new chapter thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('split')
})

// extractTranscriptCommands - combine-previous
test('extractTranscriptCommands extracts combine previous command', () => {
	const segments = createSegments([0, 3, 'Jarvis combine previous thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]).toEqual({
		type: 'combine-previous',
		window: { start: 0, end: 3 },
	})
})

// extractTranscriptCommands - nevermind
test('extractTranscriptCommands extracts nevermind cancellation', () => {
	const segments = createSegments([0, 3, 'Jarvis oops nevermind thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('nevermind')
})

test('extractTranscriptCommands extracts never mind as two words', () => {
	const segments = createSegments([0, 3, 'Jarvis oops never mind thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('nevermind')
})

// extractTranscriptCommands - multiple commands
test('extractTranscriptCommands extracts multiple commands', () => {
	const segments = createSegments(
		[0, 2, 'Jarvis bad take thanks'],
		[10, 13, 'Jarvis filename chapter one thanks'],
	)
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(2)
	expect(commands[0]?.type).toBe('bad-take')
	expect(commands[1]?.type).toBe('filename')
})

test('extractTranscriptCommands extracts multiple commands in one segment', () => {
	const segments = createSegments([
		0,
		4,
		'Jarvis bad take thanks Jarvis edit thanks',
	])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(2)
	expect(commands[0]?.type).toBe('bad-take')
	expect(commands[1]?.type).toBe('edit')
})

// extractTranscriptCommands - no commands
test('extractTranscriptCommands returns empty for normal transcript', () => {
	const segments = createSegments([
		0,
		5,
		'Hello world, this is a normal transcript',
	])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(0)
})

test('extractTranscriptCommands returns empty for empty segments', () => {
	const commands = extractTranscriptCommands([], defaultOptions)
	expect(commands).toHaveLength(0)
})

test('extractTranscriptCommands ignores jarvis without valid command starter', () => {
	const segments = createSegments([0, 2, 'Jarvis hello thanks'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(0)
})

test('extractTranscriptCommands ignores command without close word if too long', () => {
	const segments = createSegments([
		0,
		20,
		'Jarvis bad take and then a lot more content',
	])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(0)
})

// extractTranscriptCommands - edge cases
test('extractTranscriptCommands handles non-chronological segments', () => {
	const segments = createSegments([5, 8, 'bad take thanks'], [0, 3, 'Jarvis'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('bad-take')
})

test('extractTranscriptCommands handles command without close word at end', () => {
	const segments = createSegments([0, 3, 'Jarvis bad take'])
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('bad-take')
})

test('extractTranscriptCommands handles blank audio segments', () => {
	const segments = createSegments(
		[0, 1, 'Jarvis'],
		[1, 2, 'blank audio'],
		[2, 3, 'bad take thanks'],
	)
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('bad-take')
})

test('extractTranscriptCommands calculates correct window across segments', () => {
	const segments = createSegments(
		[5, 6, 'Jarvis'],
		[6, 7, 'bad'],
		[7, 8, 'take'],
		[8, 9, 'thanks'],
	)
	const commands = extractTranscriptCommands(segments, defaultOptions)
	expect(commands).toHaveLength(1)
	expect(commands[0]?.window.start).toBe(5)
	expect(commands[0]?.window.end).toBe(9)
})

// extractTranscriptCommands - custom options
test('extractTranscriptCommands uses custom wake word', () => {
	const segments = createSegments([0, 2, 'Computer bad take thanks'])
	const commands = extractTranscriptCommands(segments, {
		wakeWord: 'computer',
		closeWord: 'thanks',
	})
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('bad-take')
})

test('extractTranscriptCommands uses custom close word', () => {
	const segments = createSegments([0, 2, 'Jarvis bad take done'])
	const commands = extractTranscriptCommands(segments, {
		wakeWord: 'jarvis',
		closeWord: 'done',
	})
	expect(commands).toHaveLength(1)
	expect(commands[0]?.type).toBe('bad-take')
})
