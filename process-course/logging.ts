import { formatCommand } from "../utils";
import { buildChapterLogPath } from "./paths";

export function logCommand(command: string[]) {
  console.log(`[cmd] ${formatCommand(command)}`);
}

export function logInfo(message: string) {
  console.log(`[info] ${message}`);
}

export function logWarn(message: string) {
  console.warn(`[warn] ${message}`);
}

export async function writeChapterLog(
  tmpDir: string,
  outputPath: string,
  lines: string[],
) {
  const logPath = buildChapterLogPath(tmpDir, outputPath);
  const body = `${lines.join("\n")}\n`;
  await Bun.write(logPath, body);
}
