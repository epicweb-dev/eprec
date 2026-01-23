import path from "node:path";
import { mkdir } from "node:fs/promises";

const DEFAULT_MODEL_FILENAME = "ggml-tiny.en.bin";
const DEFAULT_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";
const DEFAULT_LANGUAGE = "en";
const DEFAULT_BINARY = "whisper-cli";

type TranscribeOptions = {
  modelPath?: string;
  language?: string;
  threads?: number;
  binaryPath?: string;
  outputBasePath?: string;
};

export function getDefaultWhisperModelPath() {
  return path.resolve(".cache", "whispercpp", DEFAULT_MODEL_FILENAME);
}

export async function transcribeAudio(
  audioPath: string,
  options: TranscribeOptions = {},
) {
  const resolvedAudioPath = path.resolve(audioPath);
  const resolvedModelPath = path.resolve(
    options.modelPath ?? getDefaultWhisperModelPath(),
  );
  const language = (options.language ?? DEFAULT_LANGUAGE).trim() || "en";
  const binaryPath = options.binaryPath ?? DEFAULT_BINARY;
  const outputBasePath =
    options.outputBasePath ??
    path.join(
      path.dirname(resolvedAudioPath),
      `${path.parse(resolvedAudioPath).name}-transcript`,
    );

  await ensureModelFile(resolvedModelPath);

  const args = [
    binaryPath,
    "-m",
    resolvedModelPath,
    "-f",
    resolvedAudioPath,
    "-l",
    language,
    "-nt",
    "-otxt",
    "-of",
    outputBasePath,
  ];

  if (options.threads && Number.isFinite(options.threads)) {
    args.push("-t", String(options.threads));
  }

  const result = await runCommand(args);
  const transcriptPath = `${outputBasePath}.txt`;
  const transcript = await readTranscript(transcriptPath, result.stdout);
  const normalized = transcript.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized;
}

async function ensureModelFile(modelPath: string) {
  const file = Bun.file(modelPath);
  if (await file.exists()) {
    return;
  }

  const defaultPath = getDefaultWhisperModelPath();
  if (path.resolve(modelPath) !== path.resolve(defaultPath)) {
    throw new Error(`Whisper model not found at ${modelPath}.`);
  }

  await mkdir(path.dirname(modelPath), { recursive: true });
  const response = await fetch(DEFAULT_MODEL_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to download whisper.cpp model (${response.status} ${response.statusText}).`,
    );
  }

  const bytes = await response.arrayBuffer();
  await Bun.write(modelPath, bytes);
}

async function readTranscript(transcriptPath: string, fallback: string) {
  const transcriptFile = Bun.file(transcriptPath);
  if (await transcriptFile.exists()) {
    return transcriptFile.text();
  }
  if (fallback.trim().length > 0) {
    return fallback;
  }
  throw new Error("Whisper.cpp transcript output was empty.");
}

async function runCommand(command: string[]) {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${exitCode}): ${formatCommand(command)}\n${stderr}`,
    );
  }

  return { stdout, stderr, exitCode };
}

function formatCommand(command: string[]) {
  return command
    .map((part) => (part.includes(" ") ? `"${part}"` : part))
    .join(" ");
}
