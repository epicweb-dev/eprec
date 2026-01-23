type RunCommandOptions = {
  allowFailure?: boolean;
  logCommand?: (command: string[]) => void;
};

export function formatCommand(command: string[]) {
  return command
    .map((part) => (part.includes(" ") ? `"${part}"` : part))
    .join(" ");
}

export async function runCommand(
  command: string[],
  options: RunCommandOptions = {},
) {
  options.logCommand?.(command);
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(
      `Command failed (${exitCode}): ${formatCommand(command)}\n${stderr}`,
    );
  }

  return { stdout, stderr, exitCode };
}

export async function runCommandBinary(
  command: string[],
  options: RunCommandOptions = {},
) {
  options.logCommand?.(command);
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(
      `Command failed (${exitCode}): ${formatCommand(command)}\n${stderr}`,
    );
  }

  return { stdout: new Uint8Array(stdout), stderr, exitCode };
}

export function formatSeconds(value: number) {
  return `${value.toFixed(2)}s`;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function toKebabCase(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/['".,]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-") || "untitled";
}
