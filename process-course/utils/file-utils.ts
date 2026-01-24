import { readdir, rmdir, unlink } from "node:fs/promises";
import { logInfo } from "../logging";

/**
 * Safely delete a file, ignoring ENOENT errors.
 */
export async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") {
        return;
      }
    }
    logInfo(
      `Failed to delete ${filePath}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Remove a directory if it exists and is empty.
 */
export async function removeDirIfEmpty(dirPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirPath);
    if (entries.length > 0) {
      return false;
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") {
        return false;
      }
    }
    logInfo(
      `Failed to read directory ${dirPath}: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  }

  try {
    await rmdir(dirPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT" || error.code === "ENOTEMPTY") {
        return false;
      }
    }
    logInfo(
      `Failed to remove directory ${dirPath}: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  }
}
