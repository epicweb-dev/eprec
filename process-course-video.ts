#!/usr/bin/env bun
import path from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import type { Argv, Arguments } from "yargs";
import * as ort from "onnxruntime-node";

type Chapter = {
  index: number;
  start: number;
  end: number;
  title: string;
};

type LoudnormAnalysis = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

type SpeechBounds = {
  start: number;
  end: number;
  note?: string;
};

type CliArgs =
  | { shouldExit: true }
  | {
      shouldExit: false;
      inputPath: string;
      outputDir: string;
      minChapterDurationSeconds: number;
      dryRun: boolean;
      keepIntermediates: boolean;
      writeLogs: boolean;
      chapterSelection: ChapterSelection | null;
    };

const CONFIG = {
  preSpeechPaddingSeconds: 0.25,
  postSpeechPaddingSeconds: 0.25,
  rawTrimPaddingSeconds: 0.1,
  vadSampleRate: 16000,
  vadWindowSamples: 512,
  vadSpeechThreshold: 0.7,
  vadNegThreshold: 0.6,
  vadMinSpeechDurationMs: 250,
  vadMinSilenceDurationMs: 120,
  vadSpeechPadMs: 10,
  vadModelUrl:
    "https://huggingface.co/freddyaboulton/silero-vad/resolve/main/silero_vad.onnx",
  normalizePrefilterEnabled: true,
  normalizePrefilter: "highpass=f=80,afftdn",
  loudnessTargetI: -16,
  loudnessTargetLra: 11,
  loudnessTargetTp: -1.5,
  videoReencodeForAccurateTrim: false,
  audioCodec: "aac",
  audioBitrate: "192k",
};

async function main() {
  const parsedArgs = parseCliArgs();
  if (parsedArgs.shouldExit) {
    return;
  }

  const {
    inputPath,
    outputDir,
    minChapterDurationSeconds,
    dryRun,
    keepIntermediates,
    writeLogs,
    chapterSelection,
  } = parsedArgs;

  const inputFile = Bun.file(inputPath);
  if (!(await inputFile.exists())) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  await ensureFfmpegAvailable();
  if (!dryRun) {
    await mkdir(outputDir, { recursive: true });
  }

  const chapters = await getChapters(inputPath);
  if (chapters.length === 0) {
    throw new Error("No chapters found. The input must contain chapters.");
  }

  const chapterIndexes = chapterSelection
    ? resolveChapterSelection(chapterSelection, chapters.length)
    : null;

  logInfo(`Chapters found: ${chapters.length}`);
  if (chapterIndexes) {
    logInfo(
      `Filtering to chapters: ${chapterIndexes.map((index) => index + 1).join(", ")}`,
    );
  }
  logInfo(
    `Skipping chapters shorter than ${formatSeconds(minChapterDurationSeconds)}.`,
  );
  if (dryRun) {
    logInfo("Dry run enabled; no files will be written.");
  } else if (keepIntermediates) {
    logInfo("Keeping intermediate files for debugging.");
  }
  if (writeLogs) {
    logInfo("Writing log files for skipped/fallback cases.");
  }
  chapters.forEach((chapter) => {
    logInfo(
      `- [${chapter.index + 1}] ${chapter.title} (${formatSeconds(
        chapter.start,
      )} -> ${formatSeconds(chapter.end)})`,
    );
  });

  const selectedChapters = chapterIndexes
    ? chapters.filter((chapter) => chapterIndexes.includes(chapter.index))
    : chapters;

  const summary = {
    totalSelected: selectedChapters.length,
    processed: 0,
    skippedShortInitial: 0,
    skippedShortTrimmed: 0,
    fallbackNotes: 0,
    logsWritten: 0,
  };
  const summaryDetails: string[] = [];

  for (const chapter of selectedChapters) {
    const duration = chapter.end - chapter.start;
    if (duration <= 0) {
      throw new Error(
        `Invalid chapter duration for "${chapter.title}" (${duration}s)`,
      );
    }

    const outputPath = path.join(
      outputDir,
      `${formatChapterFilename(chapter)}${path.extname(inputPath)}`,
    );
    const rawPath = buildIntermediatePath(outputPath, "raw");
    const normalizedPath = buildIntermediatePath(outputPath, "normalized");

    if (duration < minChapterDurationSeconds) {
      summary.skippedShortInitial += 1;
      summaryDetails.push(
        `Skipped chapter ${chapter.index + 1} (${formatSeconds(
          duration,
        )} < ${formatSeconds(minChapterDurationSeconds)}).`,
      );
      logInfo(
        `Skipping chapter ${chapter.index + 1}: ${chapter.title} (${formatSeconds(
          duration,
        )})`,
      );
      if (writeLogs) {
        if (dryRun) {
          logInfo(`[dry-run] Would write log: ${outputPath}.log`);
        } else {
          await writeChapterLog(outputPath, [
            `Chapter: ${chapter.index + 1} - ${chapter.title}`,
            `Input: ${inputPath}`,
            `Duration: ${formatSeconds(duration)}`,
            `Skip threshold: ${formatSeconds(minChapterDurationSeconds)}`,
            "Reason: Chapter shorter than minimum duration threshold.",
          ]);
          summary.logsWritten += 1;
        }
      }
      continue;
    }

    if (dryRun) {
      logInfo(
        `[dry-run] Would process chapter ${chapter.index + 1}: ${chapter.title}`,
      );
      summary.processed += 1;
      continue;
    }

    logInfo(`Processing chapter ${chapter.index + 1}: ${chapter.title}`);
    try {
      const rawTrimStart = chapter.start + CONFIG.rawTrimPaddingSeconds;
      const rawTrimEnd = chapter.end - CONFIG.rawTrimPaddingSeconds;
      const rawDuration = rawTrimEnd - rawTrimStart;
      if (rawDuration <= 0) {
        throw new Error(
          `Chapter too short to trim ${CONFIG.rawTrimPaddingSeconds}s from both ends (${formatSeconds(
            duration,
          )}).`,
        );
      }

      await extractChapterSegment({
        inputPath,
        outputPath: rawPath,
        start: rawTrimStart,
        end: rawTrimEnd,
      });

      const speechBounds = await detectSpeechBounds(
        rawPath,
        0,
        rawDuration,
        rawDuration,
      );

      if (speechBounds.note) {
        summary.fallbackNotes += 1;
        summaryDetails.push(
          `Fallback for chapter ${chapter.index + 1}: ${speechBounds.note}`,
        );
        logInfo(`Speech detection fallback: ${speechBounds.note}`);
        if (writeLogs) {
          await writeChapterLog(
            outputPath,
            [
              `Chapter: ${chapter.index + 1} - ${chapter.title}`,
              `Input: ${inputPath}`,
              `Reason: ${speechBounds.note}`,
            ],
          );
          summary.logsWritten += 1;
        }
      }

      const paddedStart = clamp(
        speechBounds.start - CONFIG.preSpeechPaddingSeconds,
        0,
        rawDuration,
      );
      const paddedEnd = clamp(
        speechBounds.end + CONFIG.postSpeechPaddingSeconds,
        0,
        rawDuration,
      );
      const trimmedDuration = paddedEnd - paddedStart;

      if (paddedEnd <= paddedStart + 0.05) {
        throw new Error(
          `Trim window too small for "${chapter.title}" (${paddedStart}s -> ${paddedEnd}s)`,
        );
      }

      logInfo(
        `Speech bounds: ${formatSeconds(speechBounds.start)} -> ${formatSeconds(
          speechBounds.end,
        )}, padded to ${formatSeconds(paddedStart)} -> ${formatSeconds(paddedEnd)}`,
      );

      const analysis = await analyzeLoudness(rawPath, 0, rawDuration);

      await renderChapter({
        inputPath: rawPath,
        outputPath: normalizedPath,
        absoluteStart: 0,
        absoluteEnd: rawDuration,
        analysis,
      });

      await extractChapterSegment({
        inputPath: normalizedPath,
        outputPath,
        start: paddedStart,
        end: paddedEnd,
      });

      if (trimmedDuration < minChapterDurationSeconds) {
        summary.skippedShortTrimmed += 1;
        summaryDetails.push(
          `Skipped chapter ${chapter.index + 1} (trimmed ${formatSeconds(
            trimmedDuration,
          )} < ${formatSeconds(minChapterDurationSeconds)}).`,
        );
        logInfo(
          `Skipping chapter ${chapter.index + 1}: ${chapter.title} (trimmed ${formatSeconds(
            trimmedDuration,
          )})`,
        );
        if (writeLogs) {
          await writeChapterLog(outputPath, [
            `Chapter: ${chapter.index + 1} - ${chapter.title}`,
            `Input: ${inputPath}`,
            `Duration: ${formatSeconds(duration)}`,
            `Trimmed duration: ${formatSeconds(trimmedDuration)}`,
            `Skip threshold: ${formatSeconds(minChapterDurationSeconds)}`,
            "Reason: Trimmed duration shorter than minimum duration threshold.",
          ]);
          summary.logsWritten += 1;
        }
        await safeUnlink(outputPath);
      } else {
        summary.processed += 1;
      }
    } finally {
      if (!keepIntermediates) {
        await safeUnlink(rawPath);
        await safeUnlink(normalizedPath);
      }
    }
  }

  const summaryLines = [
    `Input: ${inputPath}`,
    `Output dir: ${outputDir}`,
    `Chapters selected: ${summary.totalSelected}`,
    `${dryRun ? "Would process" : "Processed"} chapters: ${summary.processed}`,
    `Skipped (short initial): ${summary.skippedShortInitial}`,
    `Skipped (trimmed short): ${summary.skippedShortTrimmed}`,
    `Fallback notes: ${summary.fallbackNotes}`,
    `Log files written: ${summary.logsWritten}`,
  ];
  if (summaryDetails.length > 0) {
    summaryLines.push("Details:", ...summaryDetails);
  }

  logInfo("Summary:");
  summaryLines.forEach((line) => logInfo(line));

  if (writeLogs) {
    const summaryLogPath = buildSummaryLogPath(outputDir);
    if (dryRun) {
      logInfo(`[dry-run] Would write summary log: ${summaryLogPath}`);
    } else {
      await Bun.write(summaryLogPath, `${summaryLines.join("\n")}\n`);
    }
  }
}

function parseCliArgs(): CliArgs {
  const rawArgs = hideBin(process.argv);
  const parser = yargs(rawArgs)
    .scriptName("process-course-video")
    .usage(
      "Usage: $0 <input.mp4|input.mkv> [output-dir] [--min-chapter-seconds <number>] [--dry-run] [--keep-intermediates] [--write-logs]",
    )
    .command(
      "$0 <input> [outputDir]",
      "Process chapters into separate files",
      (command: Argv) =>
        command
          .positional("input", {
            type: "string",
            describe: "Input video file",
          })
          .positional("outputDir", {
            type: "string",
            describe: "Output directory",
            default: "output",
          })
          .option("min-chapter-seconds", {
            type: "number",
            alias: "m",
            describe: "Skip chapters shorter than this duration in seconds",
          })
          .option("dry-run", {
            type: "boolean",
            alias: "d",
            describe: "Skip writing output files and running ffmpeg",
            default: false,
          })
          .option("keep-intermediates", {
            type: "boolean",
            alias: "k",
            describe: "Keep intermediate files for debugging",
            default: false,
          })
          .option("write-logs", {
            type: "boolean",
            alias: "l",
            describe: "Write log files when skipping/fallbacks happen",
            default: false,
          })
          .option("chapter", {
            type: "string",
            array: true,
            alias: "c",
            describe:
              "Only process selected chapters (e.g. 4, 4-6, 4,6,9-12, 4-*)",
          }),
    )
    .check((args: Arguments) => {
      const minChapterSeconds = args["min-chapter-seconds"];
      if (minChapterSeconds !== undefined) {
        if (
          typeof minChapterSeconds !== "number" ||
          !Number.isFinite(minChapterSeconds) ||
          minChapterSeconds < 0
        ) {
          throw new Error("min-chapter-seconds must be a non-negative number.");
        }
      }
      return true;
    })
    .strict()
    .help();

  if (rawArgs.length === 0) {
    parser.showHelp((message) => {
      console.log(message);
    });
    return { shouldExit: true };
  }

  const argv = parser.parseSync();

  const inputPath = typeof argv.input === "string" ? argv.input : "";
  if (!inputPath) {
    throw new Error("Input file is required.");
  }

  const outputDir =
    typeof argv.outputDir === "string" && argv.outputDir.trim().length > 0
      ? argv.outputDir
      : "output";

  const minChapterDurationSeconds =
    argv["min-chapter-seconds"] === undefined
      ? 15
      : Number(argv["min-chapter-seconds"]);
  if (
    !Number.isFinite(minChapterDurationSeconds) ||
    minChapterDurationSeconds < 0
  ) {
    throw new Error("min-chapter-seconds must be a non-negative number.");
  }

  return {
    inputPath,
    outputDir,
    minChapterDurationSeconds,
    dryRun: Boolean(argv["dry-run"]),
    keepIntermediates: Boolean(argv["keep-intermediates"]),
    writeLogs: Boolean(argv["write-logs"]),
    chapterSelection:
      argv.chapter === undefined ? null : parseChapterSelection(argv.chapter),
    shouldExit: false,
  };
}

type ChapterRange = {
  start: number;
  end: number | null;
};

type ChapterSelection = {
  base: 0 | 1;
  ranges: ChapterRange[];
};

function parseChapterSelection(rawSelection: unknown): ChapterSelection {
  const rawList = Array.isArray(rawSelection) ? rawSelection : [rawSelection];
  const parts: string[] = [];

  for (const value of rawList) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "number") {
      parts.push(String(value));
      continue;
    }
    if (typeof value === "string") {
      const chunk = value.trim();
      if (chunk.length === 0) {
        continue;
      }
      parts.push(...chunk.split(",").map((item) => item.trim()).filter(Boolean));
      continue;
    }
    throw new Error("chapter must be a number or range (e.g. 4, 4-6, 4-*)");
  }

  if (parts.length === 0) {
    throw new Error("chapter must include at least one value.");
  }

  const ranges: ChapterRange[] = [];
  let hasZero = false;

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\*|\d+)$/);
    if (rangeMatch) {
      const startToken = rangeMatch[1];
      const endToken = rangeMatch[2];
      if (!startToken || !endToken) {
        throw new Error(`Invalid chapter range: "${part}".`);
      }
      const start = Number.parseInt(startToken, 10);
      const end = endToken === "*" ? null : Number.parseInt(endToken, 10);

      if (!Number.isFinite(start)) {
        throw new Error(`Invalid chapter range start: "${part}".`);
      }
      if (end !== null && !Number.isFinite(end)) {
        throw new Error(`Invalid chapter range end: "${part}".`);
      }
      if (start < 0 || (end !== null && end < 0)) {
        throw new Error(`chapter values must be >= 0: "${part}".`);
      }
      if (end !== null && end < start) {
        throw new Error(`chapter ranges must be low-to-high: "${part}".`);
      }

      if (start === 0 || end === 0) {
        hasZero = true;
      }
      ranges.push({ start, end });
      continue;
    }

    const singleMatch = part.match(/^\d+$/);
    if (singleMatch) {
      const value = Number.parseInt(part, 10);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid chapter value: "${part}".`);
      }
      if (value < 0) {
        throw new Error(`chapter values must be >= 0: "${part}".`);
      }
      if (value === 0) {
        hasZero = true;
      }
      ranges.push({ start: value, end: value });
      continue;
    }

    throw new Error(`Invalid chapter value: "${part}".`);
  }

  return { base: hasZero ? 0 : 1, ranges };
}

function resolveChapterSelection(
  selection: ChapterSelection,
  chapterCount: number,
) {
  if (!Number.isFinite(chapterCount) || chapterCount <= 0) {
    throw new Error("Chapter count must be a positive number.");
  }

  const maxIndex = chapterCount - 1;
  const maxValue = selection.base === 0 ? maxIndex : chapterCount;
  const indexes: number[] = [];

  for (const range of selection.ranges) {
    const startValue = range.start;
    const endValue = range.end === null ? maxValue : range.end;

    if (startValue > maxValue) {
      throw new Error(
        `chapter range starts at ${startValue}, but only ${chapterCount} chapters exist.`,
      );
    }
    if (endValue > maxValue) {
      throw new Error(
        `chapter range ends at ${endValue}, but only ${chapterCount} chapters exist.`,
      );
    }

    for (let value = startValue; value <= endValue; value += 1) {
      const index = selection.base === 0 ? value : value - 1;
      if (index < 0 || index > maxIndex) {
        throw new Error(
          `chapter selection ${value} is out of range for ${chapterCount} chapters.`,
        );
      }
      indexes.push(index);
    }
  }

  return Array.from(new Set(indexes)).sort((a, b) => a - b);
}

async function ensureFfmpegAvailable() {
  const ffmpeg = await runCommand(["ffmpeg", "-version"], true);
  const ffprobe = await runCommand(["ffprobe", "-version"], true);
  if (ffmpeg.exitCode !== 0 || ffprobe.exitCode !== 0) {
    throw new Error(
      "ffmpeg/ffprobe not available. Install them and ensure they are on PATH.",
    );
  }
}

async function getChapters(inputPath: string): Promise<Chapter[]> {
  const result = await runCommand([
    "ffprobe",
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_chapters",
    "-i",
    inputPath,
  ]);

  const payload = JSON.parse(result.stdout);
  const chapters = payload.chapters ?? [];
  if (chapters.length === 0) {
    return [];
  }

  return chapters.map((chapter: any, index: number) => {
    const start = Number.parseFloat(chapter.start_time);
    const end = Number.parseFloat(chapter.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`Invalid chapter time data at index ${index}`);
    }
    return {
      index,
      start,
      end,
      title: chapter.tags?.title
        ? String(chapter.tags.title)
        : `chapter-${index + 1}`,
    };
  });
}

async function detectSpeechBounds(
  inputPath: string,
  chapterStart: number,
  chapterEnd: number,
  duration: number,
): Promise<SpeechBounds> {
  /**
   * Determine the speech window inside a chapter using a VAD model.
   */
  const clipDuration = chapterEnd - chapterStart;
  if (clipDuration <= 0) {
    return {
      start: 0,
      end: duration,
      note: "Invalid chapter boundaries; using full chapter.",
    };
  }

  const samples = await readAudioSamples({
    inputPath,
    start: chapterStart,
    duration: clipDuration,
    sampleRate: CONFIG.vadSampleRate,
  });
  if (samples.length === 0) {
    return {
      start: 0,
      end: duration,
      note: `Speech detection failed near ${formatSeconds(chapterStart)}; using full chapter.`,
    };
  }

  const vadSegments = await detectSpeechSegmentsWithVad(
    samples,
    CONFIG.vadSampleRate,
  );
  if (vadSegments.length === 0) {
    return {
      start: 0,
      end: duration,
      note: `Speech detection failed near ${formatSeconds(chapterStart)}; using full chapter.`,
    };
  }
  const firstSegment = vadSegments[0];
  const lastSegment = vadSegments[vadSegments.length - 1];
  if (!firstSegment || !lastSegment) {
    return {
      start: 0,
      end: duration,
      note: `Speech detection failed near ${formatSeconds(chapterStart)}; using full chapter.`,
    };
  }
  const speechStart = firstSegment.start;
  const speechEnd = lastSegment.end;

  if (speechEnd <= speechStart + 0.1) {
    return {
      start: 0,
      end: duration,
      note: `Speech detection failed near ${formatSeconds(chapterStart)}; using full chapter.`,
    };
  }

  return { start: speechStart, end: speechEnd };
}
type VadSegment = { start: number; end: number };

let vadSessionPromise: Promise<ort.InferenceSession> | null = null;

async function detectSpeechSegmentsWithVad(
  samples: Float32Array,
  sampleRate: number,
): Promise<VadSegment[]> {
  const vadSession = await getVadSession();
  const probabilities = await getVadProbabilities(samples, sampleRate, vadSession);
  return probabilitiesToSegments(samples.length, probabilities, sampleRate);
}

async function getVadSession() {
  if (!vadSessionPromise) {
    vadSessionPromise = (async () => {
      const modelPath = await ensureVadModel();
      return ort.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
      });
    })();
  }
  return vadSessionPromise;
}

async function ensureVadModel() {
  const cacheDir = path.join(process.cwd(), ".cache");
  const modelPath = path.join(cacheDir, "silero-vad.onnx");
  const file = Bun.file(modelPath);
  if (await file.exists()) {
    return modelPath;
  }

  await mkdir(cacheDir, { recursive: true });
  const response = await fetch(CONFIG.vadModelUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download VAD model (${response.status} ${response.statusText}).`,
    );
  }
  const buffer = await response.arrayBuffer();
  await Bun.write(modelPath, new Uint8Array(buffer));
  return modelPath;
}

async function getVadProbabilities(
  samples: Float32Array,
  sampleRate: number,
  session: ort.InferenceSession,
) {
  const windowSamples = CONFIG.vadWindowSamples;
  const srTensor = new ort.Tensor(
    "int64",
    new BigInt64Array([BigInt(sampleRate)]),
    [],
  );
  const probabilities: number[] = [];
  let stateH = new Float32Array(2 * 1 * 64);
  let stateC = new Float32Array(2 * 1 * 64);

  for (let offset = 0; offset < samples.length; offset += windowSamples) {
    const chunk = samples.subarray(offset, offset + windowSamples);
    const paddedChunk = new Float32Array(windowSamples);
    paddedChunk.set(chunk);

    const inputTensor = new ort.Tensor(
      "float32",
      paddedChunk,
      [1, windowSamples],
    );
    const hTensor = new ort.Tensor("float32", stateH, [2, 1, 64]);
    const cTensor = new ort.Tensor("float32", stateC, [2, 1, 64]);

    const outputs = await session.run({
      input: inputTensor,
      sr: srTensor,
      h: hTensor,
      c: cTensor,
    });

    const { probTensor, hTensor: nextH, cTensor: nextC } = pickVadOutputs(
      outputs,
      session.outputNames,
    );
    probabilities.push((probTensor.data as Float32Array)[0] ?? 0);
    stateH = new Float32Array(nextH.data as Float32Array);
    stateC = new Float32Array(nextC.data as Float32Array);
  }

  return probabilities;
}

function pickVadOutputs(
  outputs: Record<string, ort.Tensor>,
  outputNames: readonly string[],
) {
  let probTensor: ort.Tensor | null = null;
  let hTensor: ort.Tensor | null = null;
  let cTensor: ort.Tensor | null = null;

  for (const name of outputNames) {
    const tensor = outputs[name];
    if (!tensor) {
      continue;
    }
    if (name === "output") {
      probTensor = tensor;
    } else if (name === "hn") {
      hTensor = tensor;
    } else if (name === "cn") {
      cTensor = tensor;
    }
  }

  if (!probTensor || !hTensor || !cTensor) {
    throw new Error("Unexpected VAD outputs; unable to read speech probabilities.");
  }

  return { probTensor, hTensor, cTensor };
}

function probabilitiesToSegments(
  totalSamples: number,
  probabilities: number[],
  sampleRate: number,
): VadSegment[] {
  const windowSamples = CONFIG.vadWindowSamples;
  const threshold = CONFIG.vadSpeechThreshold;
  const negThreshold = CONFIG.vadNegThreshold;
  const minSpeechSamples = (sampleRate * CONFIG.vadMinSpeechDurationMs) / 1000;
  const minSilenceSamples = (sampleRate * CONFIG.vadMinSilenceDurationMs) / 1000;
  const speechPadSamples = (sampleRate * CONFIG.vadSpeechPadMs) / 1000;

  let triggered = false;
  let tempEnd = 0;
  let currentSpeechStart = 0;
  const speeches: VadSegment[] = [];

  for (let index = 0; index < probabilities.length; index += 1) {
    const prob = probabilities[index] ?? 0;
    const currentSample = index * windowSamples;

    if (prob >= threshold && tempEnd) {
      tempEnd = 0;
    }

    if (prob >= threshold && !triggered) {
      triggered = true;
      currentSpeechStart = currentSample;
      continue;
    }

    if (prob < negThreshold && triggered) {
      if (!tempEnd) {
        tempEnd = currentSample;
      }
      if (currentSample - tempEnd < minSilenceSamples) {
        continue;
      }
      const speechEnd = tempEnd;
      if (speechEnd - currentSpeechStart >= minSpeechSamples) {
        speeches.push({ start: currentSpeechStart, end: speechEnd });
      }
      triggered = false;
      tempEnd = 0;
      currentSpeechStart = 0;
    }
  }

  if (triggered) {
    const speechEnd = totalSamples;
    if (speechEnd - currentSpeechStart >= minSpeechSamples) {
      speeches.push({ start: currentSpeechStart, end: speechEnd });
    }
  }

  if (speeches.length === 0) {
    return [];
  }

  for (let index = 0; index < speeches.length; index += 1) {
    const speech = speeches[index];
    if (!speech) {
      continue;
    }
    const nextSpeech = speeches[index + 1];
    if (index === 0) {
      speech.start = Math.max(0, speech.start - speechPadSamples);
    }
    if (nextSpeech) {
      const silence = nextSpeech.start - speech.end;
      if (silence < speechPadSamples * 2) {
        const adjustment = silence / 2;
        speech.end += adjustment;
        nextSpeech.start = Math.max(0, nextSpeech.start - adjustment);
      } else {
        speech.end = Math.min(totalSamples, speech.end + speechPadSamples);
        nextSpeech.start = Math.max(0, nextSpeech.start - speechPadSamples);
      }
    } else {
      speech.end = Math.min(totalSamples, speech.end + speechPadSamples);
    }
  }

  return speeches.map((speech) => ({
    start: speech.start / sampleRate,
    end: speech.end / sampleRate,
  }));
}

async function readAudioSamples(options: {
  inputPath: string;
  start: number;
  duration: number;
  sampleRate: number;
}) {
  const result = await runCommandBinary(
    [
      "ffmpeg",
      "-hide_banner",
      "-ss",
      options.start.toFixed(3),
      "-t",
      options.duration.toFixed(3),
      "-i",
      options.inputPath,
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      String(options.sampleRate),
      "-f",
      "f32le",
      "-",
    ],
    true,
  );

  const bytes = result.stdout;
  if (bytes.byteLength === 0) {
    return new Float32Array();
  }
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return new Float32Array(buffer);
}

function buildNormalizeAudioFilter(options: {
  printFormat: "json" | "summary";
  analysis: LoudnormAnalysis | null;
}) {
  const prefilter =
    CONFIG.normalizePrefilterEnabled && CONFIG.normalizePrefilter
      ? `${CONFIG.normalizePrefilter},`
      : "";
  const loudnorm = [
    `loudnorm=I=${CONFIG.loudnessTargetI}`,
    `LRA=${CONFIG.loudnessTargetLra}`,
    `TP=${CONFIG.loudnessTargetTp}`,
  ];

  if (options.analysis) {
    loudnorm.push(
      `measured_I=${options.analysis.input_i}`,
      `measured_TP=${options.analysis.input_tp}`,
      `measured_LRA=${options.analysis.input_lra}`,
      `measured_thresh=${options.analysis.input_thresh}`,
      `offset=${options.analysis.target_offset}`,
      "linear=true",
    );
  }

  loudnorm.push(`print_format=${options.printFormat}`);

  return `${prefilter}${loudnorm.join(":")}`;
}


async function analyzeLoudness(
  inputPath: string,
  absoluteStart: number,
  absoluteEnd: number,
): Promise<LoudnormAnalysis> {
  const clipDuration = absoluteEnd - absoluteStart;
  if (clipDuration <= 0) {
    throw new Error(
      `Invalid analysis window (${formatSeconds(absoluteStart)} -> ${formatSeconds(
        absoluteEnd,
      )})`,
    );
  }

  const filter = buildNormalizeAudioFilter({
    printFormat: "json",
    analysis: null,
  });
  const result = await runCommand(
    [
      "ffmpeg",
      "-hide_banner",
      "-ss",
      absoluteStart.toFixed(3),
      "-t",
      clipDuration.toFixed(3),
      "-i",
      inputPath,
      "-vn",
      "-sn",
      "-dn",
      "-af",
      filter,
      "-f",
      "null",
      "-",
    ],
    true,
  );

  const analysisJson = result.stderr.match(/\{[\s\S]*?\}/)?.[0];
  if (!analysisJson) {
    throw new Error("Failed to parse loudnorm analysis output.");
  }

  const payload = JSON.parse(analysisJson);
  return {
    input_i: payload.input_i,
    input_tp: payload.input_tp,
    input_lra: payload.input_lra,
    input_thresh: payload.input_thresh,
    target_offset: payload.target_offset,
  };
}

async function renderChapter(options: {
  inputPath: string;
  outputPath: string;
  absoluteStart: number;
  absoluteEnd: number;
  analysis: LoudnormAnalysis;
}) {
  const clipDuration = options.absoluteEnd - options.absoluteStart;
  if (clipDuration <= 0) {
    throw new Error(
      `Invalid render window (${formatSeconds(options.absoluteStart)} -> ${formatSeconds(
        options.absoluteEnd,
      )})`,
    );
  }

  const loudnorm = buildNormalizeAudioFilter({
    printFormat: "summary",
    analysis: options.analysis,
  });

  const args = [
    "ffmpeg",
    "-hide_banner",
    "-y",
    "-ss",
    options.absoluteStart.toFixed(3),
    "-t",
    clipDuration.toFixed(3),
    "-i",
    options.inputPath,
    "-dn",
    "-map_chapters",
    "-1",
    "-map",
    "0:v?",
    "-map",
    "0:a?",
    "-map",
    "0:s?",
  ];

  if (CONFIG.videoReencodeForAccurateTrim) {
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18");
  } else {
    args.push("-c:v", "copy");
  }

  args.push(
    "-c:a",
    CONFIG.audioCodec,
    "-b:a",
    CONFIG.audioBitrate,
    "-af",
    loudnorm,
    "-c:s",
    "copy",
    options.outputPath,
  );

  await runCommand(args);
  logInfo(`Wrote ${options.outputPath}`);
}

async function extractChapterSegment(options: {
  inputPath: string;
  outputPath: string;
  start: number;
  end: number;
}) {
  const clipDuration = options.end - options.start;
  if (clipDuration <= 0) {
    throw new Error(
      `Invalid segment window (${formatSeconds(options.start)} -> ${formatSeconds(
        options.end,
      )})`,
    );
  }

  const args = [
    "ffmpeg",
    "-hide_banner",
    "-y",
    "-ss",
    options.start.toFixed(3),
    "-t",
    clipDuration.toFixed(3),
    "-i",
    options.inputPath,
    "-dn",
    "-map_chapters",
    "-1",
    "-map",
    "0:v?",
    "-map",
    "0:a?",
    "-map",
    "0:s?",
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-c:s",
    "copy",
    options.outputPath,
  ];

  await runCommand(args);
}

async function runCommand(command: string[], allowFailure = false) {
  logCommand(command);
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0 && !allowFailure) {
    throw new Error(
      `Command failed (${exitCode}): ${formatCommand(command)}\n${stderr}`,
    );
  }

  return { stdout, stderr, exitCode };
}

async function runCommandBinary(command: string[], allowFailure = false) {
  logCommand(command);
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0 && !allowFailure) {
    throw new Error(
      `Command failed (${exitCode}): ${formatCommand(command)}\n${stderr}`,
    );
  }

  return { stdout: new Uint8Array(stdout), stderr, exitCode };
}

function formatCommand(command: string[]) {
  return command
    .map((part) => (part.includes(" ") ? `"${part}"` : part))
    .join(" ");
}

function logCommand(command: string[]) {
  console.log(`[cmd] ${formatCommand(command)}`);
}

function logInfo(message: string) {
  console.log(`[info] ${message}`);
}

function formatSeconds(value: number) {
  return `${value.toFixed(2)}s`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function buildIntermediatePath(outputPath: string, suffix: string) {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
}

function buildSummaryLogPath(outputDir: string) {
  return path.join(outputDir, "process-summary.log");
}

function formatChapterFilename(chapter: Chapter) {
  const title = chapter.title ?? `chapter-${chapter.index + 1}`;
  const slug = toKebabCase(title);
  return `chapter-${String(chapter.index + 1).padStart(2, "0")}-${slug}`;
}

function toKebabCase(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/['".,]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-") || "untitled";
}

async function writeChapterLog(outputPath: string, lines: string[]) {
  const parsed = path.parse(outputPath);
  const logPath = path.join(parsed.dir, `${parsed.name}.log`);
  const body = `${lines.join("\n")}\n`;
  await Bun.write(logPath, body);
}

async function safeUnlink(filePath: string) {
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

main().catch((error) => {
  console.error(`[error] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
