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

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptionResult = {
  text: string;
  segments: TranscriptSegment[];
};

export function getDefaultWhisperModelPath() {
  return path.resolve(".cache", "whispercpp", DEFAULT_MODEL_FILENAME);
}

export async function transcribeAudio(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<TranscriptionResult> {
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
    "-ml",
    "1",
    "-oj",
    "-otxt",
    "-of",
    outputBasePath,
  ];

  if (options.threads && Number.isFinite(options.threads)) {
    args.push("-t", String(options.threads));
  }

  const result = await runCommand(args);
  const transcriptPath = `${outputBasePath}.txt`;
  const transcript = await readTranscriptText(transcriptPath, result.stdout);
  const segments = await readTranscriptSegments(`${outputBasePath}.json`);
  const normalized = normalizeTranscriptText(transcript);
  return { text: normalized, segments };
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

async function readTranscriptText(transcriptPath: string, fallback: string) {
  const transcriptFile = Bun.file(transcriptPath);
  if (await transcriptFile.exists()) {
    return transcriptFile.text();
  }
  if (fallback.trim().length > 0) {
    return fallback;
  }
  throw new Error("Whisper.cpp transcript output was empty.");
}

async function readTranscriptSegments(
  transcriptPath: string,
): Promise<TranscriptSegment[]> {
  const transcriptFile = Bun.file(transcriptPath);
  if (!(await transcriptFile.exists())) {
    return [];
  }
  const raw = await transcriptFile.text();
  try {
    const payload = JSON.parse(raw);
    return parseTranscriptSegments(payload);
  } catch (error) {
    throw new Error(
      `Failed to parse whisper.cpp JSON transcript: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function parseTranscriptSegments(payload: unknown): TranscriptSegment[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const segments = parseSegmentsArray((payload as any).segments);
  if (segments.length > 0) {
    return segments.sort((a, b) => a.start - b.start);
  }
  const transcriptionSegments = parseTranscriptionArray(
    (payload as any).transcription,
  );
  return transcriptionSegments.sort((a, b) => a.start - b.start);
}

function parseSegmentsArray(rawSegments: unknown): TranscriptSegment[] {
  if (!Array.isArray(rawSegments)) {
    return [];
  }
  return rawSegments
    .map((segment: any) => {
      const times = getSegmentTimes(segment);
      if (!times) {
        return null;
      }
      const text =
        typeof segment.text === "string"
          ? segment.text
          : typeof segment.transcript === "string"
            ? segment.transcript
            : "";
      if (!text.trim()) {
        return null;
      }
      return {
        start: times.start,
        end: times.end,
        text: text.trim(),
      } satisfies TranscriptSegment;
    })
    .filter((segment): segment is TranscriptSegment => Boolean(segment));
}

function parseTranscriptionArray(rawTranscription: unknown): TranscriptSegment[] {
  if (!Array.isArray(rawTranscription)) {
    return [];
  }
  return rawTranscription
    .map((segment: any) => {
      if (!segment || typeof segment !== "object") {
        return null;
      }
      const offsets = (segment as any).offsets;
      if (!offsets || typeof offsets !== "object") {
        return null;
      }
      const startMs = Number((offsets as any).from);
      const endMs = Number((offsets as any).to);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return null;
      }
      if (endMs <= startMs) {
        return null;
      }
      const text = typeof (segment as any).text === "string" ? (segment as any).text : "";
      if (!text.trim()) {
        return null;
      }
      return {
        start: startMs / 1000,
        end: endMs / 1000,
        text: text.trim(),
      } satisfies TranscriptSegment;
    })
    .filter((segment): segment is TranscriptSegment => Boolean(segment));
}

function getSegmentTimes(segment: any): { start: number; end: number } | null {
  if (
    segment &&
    typeof segment.start === "number" &&
    typeof segment.end === "number"
  ) {
    if (segment.end > segment.start) {
      return { start: segment.start, end: segment.end };
    }
  }
  if (
    segment &&
    typeof segment.t0 === "number" &&
    typeof segment.t1 === "number"
  ) {
    const start = segment.t0 * 0.01;
    const end = segment.t1 * 0.01;
    if (end > start) {
      return { start, end };
    }
  }
  return null;
}

function normalizeTranscriptText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
