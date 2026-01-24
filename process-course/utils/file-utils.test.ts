import { test, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, mkdir, stat } from "node:fs/promises";
import { safeUnlink } from "./file-utils";

async function createTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "file-utils-"));
}

test("safeUnlink removes existing file", async () => {
  const tmpDir = await createTempDir();
  const filePath = path.join(tmpDir, "sample.txt");
  try {
    await Bun.write(filePath, "hello");
    expect(await Bun.file(filePath).exists()).toBe(true);
    await safeUnlink(filePath);
    expect(await Bun.file(filePath).exists()).toBe(false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("safeUnlink ignores missing files", async () => {
  const tmpDir = await createTempDir();
  const filePath = path.join(tmpDir, "missing.txt");
  try {
    await expect(safeUnlink(filePath)).resolves.toBeUndefined();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("safeUnlink does not remove directories", async () => {
  const tmpDir = await createTempDir();
  const nestedDir = path.join(tmpDir, "nested");
  try {
    await mkdir(nestedDir);
    await expect(safeUnlink(nestedDir)).resolves.toBeUndefined();
    const stats = await stat(nestedDir);
    expect(stats.isDirectory()).toBe(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
