import { unlink } from "node:fs/promises";
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
