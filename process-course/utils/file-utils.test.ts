import { test, expect } from 'bun:test'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises'
import { removeDirIfEmpty, safeUnlink } from './file-utils'

async function createTempDir(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), 'file-utils-'))
}

test('safeUnlink removes existing file', async () => {
	const tmpDir = await createTempDir()
	const filePath = path.join(tmpDir, 'sample.txt')
	try {
		await Bun.write(filePath, 'hello')
		expect(await Bun.file(filePath).exists()).toBe(true)
		await safeUnlink(filePath)
		expect(await Bun.file(filePath).exists()).toBe(false)
	} finally {
		await rm(tmpDir, { recursive: true, force: true })
	}
})

test('safeUnlink ignores missing files', async () => {
	const tmpDir = await createTempDir()
	const filePath = path.join(tmpDir, 'missing.txt')
	try {
		await expect(safeUnlink(filePath)).resolves.toBeUndefined()
	} finally {
		await rm(tmpDir, { recursive: true, force: true })
	}
})

test('safeUnlink does not remove directories', async () => {
	const tmpDir = await createTempDir()
	const nestedDir = path.join(tmpDir, 'nested')
	try {
		await mkdir(nestedDir)
		await expect(safeUnlink(nestedDir)).resolves.toBeUndefined()
		const stats = await stat(nestedDir)
		expect(stats.isDirectory()).toBe(true)
	} finally {
		await rm(tmpDir, { recursive: true, force: true })
	}
})

test('removeDirIfEmpty removes empty directories', async () => {
	const tmpDir = await createTempDir()
	const emptyDir = path.join(tmpDir, 'empty')
	try {
		await mkdir(emptyDir)
		const removed = await removeDirIfEmpty(emptyDir)
		expect(removed).toBe(true)
		await expect(stat(emptyDir)).rejects.toMatchObject({ code: 'ENOENT' })
	} finally {
		await rm(tmpDir, { recursive: true, force: true })
	}
})

test('removeDirIfEmpty keeps directories with files', async () => {
	const tmpDir = await createTempDir()
	const filledDir = path.join(tmpDir, 'filled')
	try {
		await mkdir(filledDir)
		await Bun.write(path.join(filledDir, 'sample.txt'), 'data')
		const removed = await removeDirIfEmpty(filledDir)
		expect(removed).toBe(false)
		const stats = await stat(filledDir)
		expect(stats.isDirectory()).toBe(true)
	} finally {
		await rm(tmpDir, { recursive: true, force: true })
	}
})

test('removeDirIfEmpty ignores missing directories', async () => {
	const tmpDir = await createTempDir()
	const missingDir = path.join(tmpDir, 'missing')
	try {
		await expect(removeDirIfEmpty(missingDir)).resolves.toBe(false)
	} finally {
		await rm(tmpDir, { recursive: true, force: true })
	}
})
