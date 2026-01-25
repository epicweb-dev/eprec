import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { $ } from 'bun'
import {
	buildJarvisEditLogPath,
	buildJarvisWarningLogPath,
	buildJarvisNoteLogPath,
} from '../process-course/paths'
import { extractTranscriptionAudio } from '../process-course/ffmpeg'
import { transcriptIncludesWord } from '../process-course/utils/transcript'
import { transcribeAudio } from '../src/whispercpp-transcribe'
import { runCommand, getMediaDurationSeconds } from '../src/utils'
import { detectSpeechBounds } from '../src/speech-detection'
import { CONFIG, EDIT_CONFIG } from '../process-course/config'

const TEST_OUTPUT_DIR = path.join(process.cwd(), '.test-output', 'e2e-test')
const TEST_TRANSCRIPT_DIR = path.join(
	TEST_OUTPUT_DIR,
	'.tmp',
	'e2e-transcripts',
)
const TMP_DIR = path.join(TEST_OUTPUT_DIR, '.tmp')
const FIXTURE_PATH = path.resolve('fixtures/e2e-test.mp4')

// Helper to check if file exists
async function fileExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath)
		return true
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error) {
			if (error.code === 'ENOENT') {
				return false
			}
		}
		throw error
	}
}

// Helper to read file contents
async function readFile(filePath: string): Promise<string> {
	const file = Bun.file(filePath)
	return file.text()
}

// Helper to get file size in bytes
async function getFileSize(filePath: string): Promise<number> {
	const file = Bun.file(filePath)
	return file.size
}

// Helper to list files in directory with extension filter
async function listFiles(dir: string, ext?: string): Promise<string[]> {
	const glob = new Bun.Glob(ext ? `*${ext}` : '*')
	const files: string[] = []
	for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
		files.push(file)
	}
	return files.sort()
}

function createExpectedWords(...words: string[]): string[] {
	return words
}

function createExpectedWordGroup(...words: string[]): string[] {
	return words
}

async function ensureTranscriptDir(): Promise<string> {
	await mkdir(TEST_TRANSCRIPT_DIR, { recursive: true })
	return TEST_TRANSCRIPT_DIR
}

async function transcribeOutputVideo(outputPath: string): Promise<string> {
	const transcriptDir = await ensureTranscriptDir()
	const baseName = path.parse(outputPath).name
	const audioPath = path.join(transcriptDir, `${baseName}-output.wav`)
	const outputBasePath = path.join(
		transcriptDir,
		`${baseName}-output-transcript`,
	)
	const duration = await getMediaDurationSeconds(outputPath)
	await extractTranscriptionAudio({
		inputPath: outputPath,
		outputPath: audioPath,
		start: 0,
		end: duration,
	})
	const transcript = await transcribeAudio(audioPath, { outputBasePath })
	return transcript.text
}

function expectTranscriptIncludesWords(
	transcript: string,
	expectedWords: string[],
) {
	for (const word of expectedWords) {
		expect(transcriptIncludesWord(transcript, word)).toBe(true)
	}
}

function expectTranscriptIncludesWordGroup(
	transcript: string,
	wordGroup: string[],
) {
	const matches = wordGroup.some((word) =>
		transcriptIncludesWord(transcript, word),
	)
	expect(matches).toBe(true)
}

// Helper to get video duration in seconds using ffprobe
async function getVideoDuration(filePath: string): Promise<number> {
	const result =
		await $`ffprobe -v quiet -show_entries format=duration -of csv=p=0 ${filePath}`.quiet()
	return parseFloat(result.text().trim())
}

// Helper to get video metadata (codec, width, height)
async function getVideoMetadata(
	filePath: string,
): Promise<{ codec: string; width: number; height: number }> {
	const result =
		await $`ffprobe -v quiet -show_entries stream=codec_name,width,height -of csv=p=0 ${filePath}`.quiet()
	const lines = result.text().trim().split('\n')
	// First line is video stream: codec,width,height
	const firstLine = lines[0] ?? ''
	const parts = firstLine.split(',')
	const codec = parts[0] ?? ''
	const width = parseInt(parts[1] ?? '0', 10)
	const height = parseInt(parts[2] ?? '0', 10)
	return { codec, width, height }
}

beforeAll(async () => {
	// Clean up any previous test output
	await rm(TEST_OUTPUT_DIR, { recursive: true, force: true })

	// Run the full pipeline
	const result =
		await $`bun src/cli.ts process ${FIXTURE_PATH} ${TEST_OUTPUT_DIR} --min-chapter-seconds 2 -k`.quiet()

	if (result.exitCode !== 0) {
		console.error('Pipeline failed:', result.stderr.toString())
		throw new Error(`Pipeline exited with code ${result.exitCode}`)
	}
}, 300000) // 5 minute timeout for processing

afterAll(async () => {
	await rm(TEST_OUTPUT_DIR, { recursive: true, force: true })
})

// =============================================================================
// Output File Tests
// =============================================================================

test('e2e produces exactly 7 output video files', async () => {
	const mp4Files = await listFiles(TEST_OUTPUT_DIR, '.mp4')
	expect(mp4Files).toHaveLength(7)
})

test('e2e produces expected output filenames', async () => {
	const mp4Files = await listFiles(TEST_OUTPUT_DIR, '.mp4')

	expect(mp4Files).toEqual([
		'chapter-01-start.mp4',
		'chapter-03-custom-output.mp4',
		'chapter-04-unnamed-3.mp4',
		'chapter-05-unnamed-4.mp4',
		'chapter-06-unnamed-5.mp4',
		'chapter-07-unnamed-6.mp4',
		'chapter-10-unnamed-9.mp4',
	])
})

// =============================================================================
// Video Duration Assertions
// =============================================================================

test('e2e output videos have reasonable durations (3-12 seconds each)', async () => {
	const mp4Files = await listFiles(TEST_OUTPUT_DIR, '.mp4')

	for (const file of mp4Files) {
		const duration = await getVideoDuration(path.join(TEST_OUTPUT_DIR, file))
		expect(duration).toBeGreaterThanOrEqual(3)
		expect(duration).toBeLessThanOrEqual(12)
	}
})

test('e2e combined output duration is less than input duration', async () => {
	const inputDuration = await getVideoDuration(FIXTURE_PATH)
	const mp4Files = await listFiles(TEST_OUTPUT_DIR, '.mp4')

	let totalOutputDuration = 0
	for (const file of mp4Files) {
		totalOutputDuration += await getVideoDuration(
			path.join(TEST_OUTPUT_DIR, file),
		)
	}

	// Output should be significantly less due to skipped chapters and trimming
	expect(totalOutputDuration).toBeLessThan(inputDuration)
	// But should still have substantial content (at least 40% of input)
	expect(totalOutputDuration).toBeGreaterThan(inputDuration * 0.4)
})

// =============================================================================
// Video Metadata Consistency
// =============================================================================

test('e2e all output videos have consistent codec and resolution', async () => {
	const mp4Files = await listFiles(TEST_OUTPUT_DIR, '.mp4')
	expect(mp4Files.length).toBeGreaterThan(0)

	const firstFile = mp4Files[0]!
	const firstMeta = await getVideoMetadata(
		path.join(TEST_OUTPUT_DIR, firstFile),
	)

	for (const file of mp4Files) {
		const meta = await getVideoMetadata(path.join(TEST_OUTPUT_DIR, file))
		expect(meta.codec).toBe(firstMeta.codec)
		expect(meta.width).toBe(firstMeta.width)
		expect(meta.height).toBe(firstMeta.height)
	}
})

// =============================================================================
// File Size Assertions
// =============================================================================

test('e2e output files have reasonable sizes (50KB-500KB each)', async () => {
	const mp4Files = await listFiles(TEST_OUTPUT_DIR, '.mp4')

	for (const file of mp4Files) {
		const size = await getFileSize(path.join(TEST_OUTPUT_DIR, file))
		expect(size).toBeGreaterThan(50_000) // At least 50KB
		expect(size).toBeLessThan(500_000) // Less than 500KB
	}
})

// =============================================================================
// Chapter 1: Normal Processing
// =============================================================================

test('e2e chapter 1 processes normally without commands', async () => {
	const outputPath = path.join(TEST_OUTPUT_DIR, 'chapter-01-start.mp4')
	const exists = await fileExists(outputPath)
	expect(exists).toBe(true)
})

// =============================================================================
// Chapter 2: Bad Take (should be skipped)
// =============================================================================

test('e2e chapter 2 is skipped due to bad-take command', async () => {
	// Chapter 2 should not produce an output file
	const mp4Files = await listFiles(TEST_OUTPUT_DIR, '.mp4')
	const chapter2Files = mp4Files.filter((f) => f.startsWith('chapter-02'))
	expect(chapter2Files).toHaveLength(0)
})

// =============================================================================
// Chapter 3: Filename Override
// =============================================================================

test('e2e chapter 3 uses custom filename from filename command', async () => {
	const outputPath = path.join(TEST_OUTPUT_DIR, 'chapter-03-custom-output.mp4')
	const exists = await fileExists(outputPath)
	expect(exists).toBe(true)
})

// =============================================================================
// Chapter 4: Edit Flag
// =============================================================================

test('e2e chapter 4 processes and is logged for editing', async () => {
	const outputPath = path.join(TEST_OUTPUT_DIR, 'chapter-04-unnamed-3.mp4')
	const exists = await fileExists(outputPath)
	expect(exists).toBe(true)
})

test('e2e jarvis-edits.log contains chapter 4', async () => {
	const editLogPath = buildJarvisEditLogPath(TEST_OUTPUT_DIR)
	const content = await readFile(editLogPath)

	expect(content).toContain('Edit commands: 1')
	expect(content).toContain('Chapter 4: Unnamed 3')
	expect(content).toContain('chapter-04-unnamed-3.mp4')
})

// =============================================================================
// Edit Workflow Tests (Chapter 4)
// =============================================================================

test('e2e edit workflow creates edits directory for chapter 4', async () => {
	const editsDir = path.join(TEST_OUTPUT_DIR, 'edits', 'chapter-04-unnamed-3')
	const exists = await fileExists(editsDir)
	expect(exists).toBe(true)
})

test('e2e edit workflow creates transcript.txt for chapter 4', async () => {
	const transcriptPath = path.join(
		TEST_OUTPUT_DIR,
		'edits',
		'chapter-04-unnamed-3',
		'transcript.txt',
	)
	const exists = await fileExists(transcriptPath)
	expect(exists).toBe(true)
	const content = await readFile(transcriptPath)
	expect(content.length).toBeGreaterThan(0)
	expect(content.toLowerCase()).toContain('manual')
})

test('e2e edit workflow creates transcript.json for chapter 4', async () => {
	const transcriptPath = path.join(
		TEST_OUTPUT_DIR,
		'edits',
		'chapter-04-unnamed-3',
		'transcript.json',
	)
	const exists = await fileExists(transcriptPath)
	expect(exists).toBe(true)
	const content = await readFile(transcriptPath)
	const parsed = JSON.parse(content)
	expect(parsed.version).toBe(1)
	expect(parsed.source_video).toBeDefined()
	expect(parsed.words).toBeInstanceOf(Array)
	expect(parsed.words.length).toBeGreaterThan(0)
	expect(parsed.words[0]).toHaveProperty('word')
	expect(parsed.words[0]).toHaveProperty('start')
	expect(parsed.words[0]).toHaveProperty('end')
	expect(parsed.words[0]).toHaveProperty('index')
})

test("e2e edit workflow removes word 'manual' from chapter 4", async () => {
	const editsDir = path.join(TEST_OUTPUT_DIR, 'edits', 'chapter-04-unnamed-3')
	const transcriptTxtPath = path.join(editsDir, 'transcript.txt')
	const transcriptJsonPath = path.join(editsDir, 'transcript.json')
	const originalVideoPath = path.join(editsDir, 'original.mp4')
	const editedOutputPath = path.join(
		TEST_OUTPUT_DIR,
		'chapter-04-unnamed-3.edited.mp4',
	)

	const originalText = await readFile(transcriptTxtPath)
	const editedText = originalText
		.replace(/\bmanual\b/gi, '')
		.replace(/\s+/g, ' ')
		.trim()
	const tempEditedPath = path.join(editsDir, 'transcript-edited-test.txt')
	await Bun.write(tempEditedPath, editedText)

	const result =
		await $`bun src/cli.ts edit --input ${originalVideoPath} --transcript ${transcriptJsonPath} --edited ${tempEditedPath} --output ${editedOutputPath}`.quiet()
	expect(result.exitCode).toBe(0)

	const editedExists = await fileExists(editedOutputPath)
	expect(editedExists).toBe(true)

	const editedTranscript = await transcribeOutputVideo(editedOutputPath)
	expect(transcriptIncludesWord(editedTranscript, 'manual')).toBe(false)
	expectTranscriptIncludesWords(
		editedTranscript,
		createExpectedWords('chapter', 'flagged', 'editing'),
	)
}, 60000)

// =============================================================================
// Chapter 5: Note Command
// =============================================================================

test('e2e chapter 5 processes and note is logged', async () => {
	const outputPath = path.join(TEST_OUTPUT_DIR, 'chapter-05-unnamed-4.mp4')
	const exists = await fileExists(outputPath)
	expect(exists).toBe(true)
})

test('e2e jarvis-notes.log contains chapter 5 note', async () => {
	const noteLogPath = buildJarvisNoteLogPath(TEST_OUTPUT_DIR)
	const content = await readFile(noteLogPath)

	expect(content).toContain('Note commands: 1')
	expect(content).toContain('Chapter 5: Unnamed 4')
	expect(content).toContain('chapter-05-unnamed-4.mp4')
	expect(content).toContain('remember to add graphics here')
})

// =============================================================================
// Chapter 6: Nevermind Cancellation
// =============================================================================

test('e2e chapter 6 processes with nevermind command removed', async () => {
	const outputPath = path.join(TEST_OUTPUT_DIR, 'chapter-06-unnamed-5.mp4')
	const exists = await fileExists(outputPath)
	expect(exists).toBe(true)
})

// =============================================================================
// Chapter 7 + 8: Split Base + Combine Previous
// =============================================================================

test('e2e chapter 7 and 8 are combined into single output', async () => {
	// Chapter 7 should exist (with chapter 8 combined into it)
	const chapter7Path = path.join(TEST_OUTPUT_DIR, 'chapter-07-unnamed-6.mp4')
	const chapter7Exists = await fileExists(chapter7Path)
	expect(chapter7Exists).toBe(true)

	// Chapter 8 should NOT have a separate output file
	const mp4Files = await listFiles(TEST_OUTPUT_DIR, '.mp4')
	const chapter8Files = mp4Files.filter((f) => f.startsWith('chapter-08'))
	expect(chapter8Files).toHaveLength(0)
})

test('e2e combined chapter retains chapter 7 speech content', async () => {
	const chapter7Path = path.join(TEST_OUTPUT_DIR, 'chapter-07-unnamed-6.mp4')
	const transcript = await transcribeOutputVideo(chapter7Path)
	expectTranscriptIncludesWords(
		transcript,
		createExpectedWords('split', 'test', 'previous', 'joins'),
	)
	expectTranscriptIncludesWordGroup(
		transcript,
		createExpectedWordGroup('combine', 'combined'),
	)
}, 20000)

// =============================================================================
// Combine Workflow Tests (Chapter 7+8)
// =============================================================================

test('e2e combine workflow creates edits directory for combined chapter', async () => {
	const editsDir = path.join(TEST_OUTPUT_DIR, 'edits', 'chapter-07-unnamed-6')
	const exists = await fileExists(editsDir)
	expect(exists).toBe(true)
})

test('e2e combined chapter keeps join silence within max padding', async () => {
	const prevTrimPath = path.join(
		TMP_DIR,
		'chapter-08-unnamed-7-previous-trimmed.mp4',
	)
	const currTrimPath = path.join(
		TMP_DIR,
		'chapter-08-unnamed-7-current-trimmed.mp4',
	)
	expect(await fileExists(prevTrimPath)).toBe(true)
	expect(await fileExists(currTrimPath)).toBe(true)

	const prevDuration = await getMediaDurationSeconds(prevTrimPath)
	const currDuration = await getMediaDurationSeconds(currTrimPath)
	const prevBounds = await detectSpeechBounds(
		prevTrimPath,
		0,
		prevDuration,
		prevDuration,
	)
	const currBounds = await detectSpeechBounds(
		currTrimPath,
		0,
		currDuration,
		currDuration,
	)
	const trailingSilence = Math.max(0, prevDuration - prevBounds.end)
	const leadingSilence = Math.max(0, currBounds.start)
	const gap = trailingSilence + leadingSilence
	const paddingSeconds = EDIT_CONFIG.speechBoundaryPaddingMs / 1000
	const vadSlackSeconds =
		(CONFIG.vadMinSilenceDurationMs + CONFIG.vadSpeechPadMs) / 1000
	const maxGap = paddingSeconds * 2 + vadSlackSeconds
	expect(gap).toBeLessThanOrEqual(maxGap)
}, 30000)

test('e2e combine edit errors on word modification (chicken test)', async () => {
	const editsDir = path.join(TEST_OUTPUT_DIR, 'edits', 'chapter-07-unnamed-6')
	const transcriptTxtPath = path.join(editsDir, 'transcript.txt')
	const transcriptJsonPath = path.join(editsDir, 'transcript.json')
	const originalVideoPath = path.join(editsDir, 'original.mp4')
	const editedOutputPath = path.join(
		TEST_OUTPUT_DIR,
		'chapter-07-error-test.mp4',
	)

	const originalText = await readFile(transcriptTxtPath)
	const editedText = originalText
		.replace(/joins with chapter seven/gi, 'chicken')
		.replace(/\s+/g, ' ')
		.trim()
	const tempEditedPath = path.join(editsDir, 'transcript-error-test.txt')
	await Bun.write(tempEditedPath, editedText)

	const result =
		await $`bun src/cli.ts edit --input ${originalVideoPath} --transcript ${transcriptJsonPath} --edited ${tempEditedPath} --output ${editedOutputPath}`
			.quiet()
			.nothrow()
	expect(result.exitCode).not.toBe(0)
	expect(result.stderr.toString()).toContain('mismatch')
}, 30000)

test('e2e combine edit removes a unique word successfully', async () => {
	const editsDir = path.join(TEST_OUTPUT_DIR, 'edits', 'chapter-07-unnamed-6')
	const transcriptTxtPath = path.join(editsDir, 'transcript.txt')
	const transcriptJsonPath = path.join(editsDir, 'transcript.json')
	const originalVideoPath = path.join(editsDir, 'original.mp4')
	const editedOutputPath = path.join(
		TEST_OUTPUT_DIR,
		'chapter-07-word-removed.mp4',
	)

	const originalText = await readFile(transcriptTxtPath)
	const words = originalText.split(/\s+/).filter(Boolean)
	const counts = new Map<string, number>()
	for (const word of words) {
		counts.set(word, (counts.get(word) ?? 0) + 1)
	}
	const banned = new Set(['jarvis', 'split', 'test', 'joins', 'seven'])
	const removableWord =
		words.find(
			(word) =>
				(counts.get(word) ?? 0) === 1 && word.length > 3 && !banned.has(word),
		) ?? words.find((word) => !banned.has(word))
	expect(removableWord).toBeDefined()

	const editedText = words
		.filter((word) => word !== removableWord)
		.join(' ')
		.trim()
	const tempEditedPath = path.join(editsDir, 'transcript-word-removed.txt')
	await Bun.write(tempEditedPath, editedText)

	const result =
		await $`bun src/cli.ts edit --input ${originalVideoPath} --transcript ${transcriptJsonPath} --edited ${tempEditedPath} --output ${editedOutputPath}`.quiet()
	expect(result.exitCode).toBe(0)

	const editedExists = await fileExists(editedOutputPath)
	expect(editedExists).toBe(true)

	const editedTranscript = await transcribeOutputVideo(editedOutputPath)
	expect(transcriptIncludesWord(editedTranscript, removableWord ?? '')).toBe(
		false,
	)
	expectTranscriptIncludesWordGroup(
		editedTranscript,
		createExpectedWordGroup('split', 'test'),
	)
	expectTranscriptIncludesWordGroup(
		editedTranscript,
		createExpectedWordGroup('joins', 'seven'),
	)
}, 60000)

// =============================================================================
// Chapter 9: Too Short
// =============================================================================

test('e2e chapter 9 is skipped due to short transcript', async () => {
	// Chapter 9 should not produce an output file
	const mp4Files = await listFiles(TEST_OUTPUT_DIR, '.mp4')
	const chapter9Files = mp4Files.filter((f) => f.startsWith('chapter-09'))
	expect(chapter9Files).toHaveLength(0)
})

// =============================================================================
// Chapter 10: New Chapter (Split) Command
// =============================================================================

test('e2e chapter 10 processes with split command', async () => {
	const outputPath = path.join(TEST_OUTPUT_DIR, 'chapter-10-unnamed-9.mp4')
	const exists = await fileExists(outputPath)
	expect(exists).toBe(true)
})

// =============================================================================
// Chapter 11: Extra Blank Chapter (should be skipped)
// =============================================================================

test('e2e chapter 11 is skipped due to blank audio', async () => {
	// Chapter 11 should not produce an output file
	const mp4Files = await listFiles(TEST_OUTPUT_DIR, '.mp4')
	const chapter11Files = mp4Files.filter((f) => f.startsWith('chapter-11'))
	expect(chapter11Files).toHaveLength(0)
})

// =============================================================================
// Jarvis Warning Log
// =============================================================================

test('e2e jarvis-warnings.log shows no jarvis detected', async () => {
	const warningLogPath = buildJarvisWarningLogPath(TEST_OUTPUT_DIR)
	const content = await readFile(warningLogPath)

	expect(content).toContain('Jarvis warnings: 0')
	expect(content).toContain('Detected in: none')
})

// =============================================================================
// All Log Files Exist
// =============================================================================

test('e2e produces all expected log files', async () => {
	const warningLogExists = await fileExists(
		buildJarvisWarningLogPath(TEST_OUTPUT_DIR),
	)
	const editLogExists = await fileExists(
		buildJarvisEditLogPath(TEST_OUTPUT_DIR),
	)
	const noteLogExists = await fileExists(
		buildJarvisNoteLogPath(TEST_OUTPUT_DIR),
	)

	expect(warningLogExists).toBe(true)
	expect(editLogExists).toBe(true)
	expect(noteLogExists).toBe(true)
})

// =============================================================================
// Intermediate Files (with -k flag)
// =============================================================================

test('e2e keeps intermediate files in .tmp directory', async () => {
	// Should have transcription files for processed chapters
	const wavFiles = await listFiles(TMP_DIR, '.wav')
	expect(wavFiles.length).toBeGreaterThan(0)

	// Should have intermediate video files
	const mp4Files = await listFiles(TMP_DIR, '.mp4')
	expect(mp4Files.length).toBeGreaterThan(0)
})

// =============================================================================
// Intermediate File Assertions
// =============================================================================

test('e2e generates transcript txt files for all chapters', async () => {
	const txtFiles = await listFiles(TMP_DIR, '-transcribe.txt')
	// Should have transcripts for chapters 1-11 (11 total)
	expect(txtFiles.length).toBeGreaterThanOrEqual(10)
})

test('e2e generates transcript json files for all chapters', async () => {
	const jsonFiles = (await listFiles(TMP_DIR, '.json')).filter((f) =>
		f.includes('-transcribe.json'),
	)
	expect(jsonFiles.length).toBeGreaterThanOrEqual(10)
})

test('e2e chapter 1 transcript contains expected content', async () => {
	const transcript = await readFile(
		path.join(TMP_DIR, 'chapter-01-start-transcribe.txt'),
	)
	// Should contain key phrases from script (case insensitive, allowing for transcription variance)
	expect(transcript.toLowerCase()).toContain('chapter')
	expect(transcript.toLowerCase()).toContain('normal')
})

test('e2e chapter 9 transcript is too short (skipped chapter)', async () => {
	const transcript = await readFile(
		path.join(TMP_DIR, 'chapter-09-unnamed-8-transcribe.txt'),
	)
	// Very short transcript (just "hi" or similar)
	expect(transcript.trim().length).toBeLessThan(50)
})

test('e2e chapter 11 transcript indicates blank audio', async () => {
	const transcript = await readFile(
		path.join(TMP_DIR, 'chapter-11-unnamed-10-transcribe.txt'),
	)
	expect(transcript).toContain('BLANK_AUDIO')
})

// =============================================================================
// Combined Chapter Duration Assertion
// =============================================================================

test('e2e chapter 7 (combined with 8) has longer duration than simple chapters', async () => {
	const chapter7Duration = await getVideoDuration(
		path.join(TEST_OUTPUT_DIR, 'chapter-07-unnamed-6.mp4'),
	)
	const chapter5Duration = await getVideoDuration(
		path.join(TEST_OUTPUT_DIR, 'chapter-05-unnamed-4.mp4'),
	)

	// Chapter 7 includes content from chapter 8, so should be longer than a simple chapter
	// Allow some variance but chapter 7+8 combined should be at least as long as a single chapter
	expect(chapter7Duration).toBeGreaterThanOrEqual(chapter5Duration * 0.8)
})

// =============================================================================
// Jarvis Command File Assertions
// =============================================================================

test('e2e generates jarvis wav files for chapters with commands', async () => {
	const jarvisWavFiles = (await listFiles(TMP_DIR, '.wav')).filter((f) =>
		f.includes('-jarvis.wav'),
	)
	// Should have jarvis audio extraction for chapters with voice commands
	expect(jarvisWavFiles.length).toBeGreaterThanOrEqual(5)
})

test('e2e generates jarvis json files with transcription data', async () => {
	const jarvisJsonFiles = (await listFiles(TMP_DIR, '.json')).filter((f) =>
		f.includes('-jarvis.json'),
	)
	expect(jarvisJsonFiles.length).toBeGreaterThanOrEqual(4)

	// Verify JSON structure
	const jsonContent = await readFile(
		path.join(TMP_DIR, 'chapter-03-unnamed-2-jarvis.json'),
	)
	const parsed = JSON.parse(jsonContent)
	expect(parsed).toHaveProperty('transcription')
	expect(Array.isArray(parsed.transcription)).toBe(true)
})

// =============================================================================
// Log File Format Assertions
// =============================================================================

test('e2e edit log contains input/output paths', async () => {
	const content = await readFile(buildJarvisEditLogPath(TEST_OUTPUT_DIR))
	expect(content).toContain('Input:')
	expect(content).toContain('Output dir:')
	expect(content).toContain('e2e-test.mp4')
})

test('e2e notes log contains input/output paths', async () => {
	const content = await readFile(buildJarvisNoteLogPath(TEST_OUTPUT_DIR))
	expect(content).toContain('Input:')
	expect(content).toContain('Output dir:')
})

test('e2e warnings log contains input/output paths', async () => {
	const content = await readFile(buildJarvisWarningLogPath(TEST_OUTPUT_DIR))
	expect(content).toContain('Input:')
	expect(content).toContain('Output dir:')
})

// =============================================================================
// Pipeline Intermediate Video File Assertions
// =============================================================================

test('e2e creates raw video files for chapter extraction', async () => {
	const rawFiles = (await listFiles(TMP_DIR, '.mp4')).filter((f) =>
		f.includes('-raw.mp4'),
	)
	// Should have raw extracts for multiple chapters
	expect(rawFiles.length).toBeGreaterThanOrEqual(5)
})

test('e2e creates spliced video files for chapters with jarvis commands', async () => {
	const splicedFiles = (await listFiles(TMP_DIR, '.mp4')).filter((f) =>
		f.includes('-spliced.mp4'),
	)
	// Chapters with commands that need audio removed should have spliced files
	expect(splicedFiles.length).toBeGreaterThanOrEqual(3)
})

test('e2e creates normalized video files', async () => {
	const normalizedFiles = (await listFiles(TMP_DIR, '.mp4')).filter((f) =>
		f.includes('-normalized.mp4'),
	)
	// Should have normalized outputs for processed chapters
	expect(normalizedFiles.length).toBeGreaterThanOrEqual(5)
})

// =============================================================================
// Jarvis Text File Content Assertions
// =============================================================================

test('e2e chapter 3 jarvis txt contains filename command content', async () => {
	const content = await readFile(
		path.join(TMP_DIR, 'chapter-03-unnamed-2-jarvis.txt'),
	)
	// The jarvis audio should have transcribed the filename command area
	expect(content.toLowerCase()).toContain('file')
})

test('e2e chapter 6 jarvis txt exists for nevermind detection', async () => {
	const exists = await fileExists(
		path.join(TMP_DIR, 'chapter-06-unnamed-5-jarvis.txt'),
	)
	expect(exists).toBe(true)
})
