#!/usr/bin/env bun
import path from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import type { Argv, Arguments } from "yargs";
import { detectSpeechSegmentsWithVad } from "./speech-detection";
import {
  getDefaultWhisperModelPath,
  transcribeAudio,
} from "./whispercpp-transcribe";

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

type ChapterRange = {
  start: number;
  end: number | null;
};

type ChapterSelection = {
  base: 0 | 1;
  ranges: ChapterRange[];
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

const DEFAULT_MIN_CHAPTER_SECONDS = 15;
const TRANSCRIPTION_PHRASES = ["jarvis bad take", "bad take jarvis"];
const TRANSCRIPTION_SAMPLE_RATE = 16000;

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
    enableTranscription,
    whisperModelPath,
    whisperLanguage,
    whisperBinaryPath,
    whisperSkipPhrases,
  } = parsedArgs;
  const tmpDir = path.join(outputDir, ".tmp");

  const inputFile = Bun.file(inputPath);
  if (!(await inputFile.exists())) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  await ensureFfmpegAvailable();
  if (!dryRun) {
    await mkdir(outputDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
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
  if (enableTranscription) {
    logInfo(
      `Whisper transcription enabled (model: ${whisperModelPath}, language: ${whisperLanguage}, binary: ${whisperBinaryPath}).`,
    );
    logInfo(
      `Whisper skip phrases: ${whisperSkipPhrases.length > 0 ? whisperSkipPhrases.join(", ") : "none"}.`,
    );
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
    skippedTranscription: 0,
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
    const rawPath = buildIntermediatePath(tmpDir, outputPath, "raw");
    const normalizedPath = buildIntermediatePath(tmpDir, outputPath, "normalized");
    const transcriptionAudioPath = buildIntermediateAudioPath(
      tmpDir,
      outputPath,
      "transcribe",
    );
    const transcriptionOutputBase = buildTranscriptionOutputBase(
      tmpDir,
      outputPath,
    );
    const transcriptionTextPath = `${transcriptionOutputBase}.txt`;

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
          logInfo(
            `[dry-run] Would write log: ${buildChapterLogPath(tmpDir, outputPath)}`,
          );
        } else {
          await writeChapterLog(tmpDir, outputPath, [
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
            tmpDir,
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
          await writeChapterLog(tmpDir, outputPath, [
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
        continue;
      }

      if (enableTranscription) {
        await extractTranscriptionAudio({
          inputPath: normalizedPath,
          outputPath: transcriptionAudioPath,
          start: paddedStart,
          end: paddedEnd,
        });
        const transcript = await transcribeAudio(transcriptionAudioPath, {
          modelPath: whisperModelPath,
          language: whisperLanguage,
          binaryPath: whisperBinaryPath,
          outputBasePath: transcriptionOutputBase,
        });
        const transcriptWordCount = countTranscriptWords(transcript);
        if (transcriptWordCount <= 10) {
          summary.skippedTranscription += 1;
          summaryDetails.push(
            `Skipped chapter ${chapter.index + 1} (transcript too short).`,
          );
          logInfo(
            `Skipping chapter ${chapter.index + 1}: transcript too short (${transcriptWordCount} words).`,
          );
          if (writeLogs) {
            await writeChapterLog(tmpDir, outputPath, [
              `Chapter: ${chapter.index + 1} - ${chapter.title}`,
              `Input: ${inputPath}`,
              `Duration: ${formatSeconds(duration)}`,
              `Trimmed duration: ${formatSeconds(trimmedDuration)}`,
              `Transcript words: ${transcriptWordCount}`,
              "Reason: Transcript too short for skip phrase check.",
            ]);
            summary.logsWritten += 1;
          }
          await safeUnlink(outputPath);
          continue;
        }

        if (matchesTranscriptionPhrase(transcript, whisperSkipPhrases)) {
          summary.skippedTranscription += 1;
          summaryDetails.push(
            `Skipped chapter ${chapter.index + 1} (transcription phrase detected).`,
          );
          logInfo(
            `Skipping chapter ${chapter.index + 1}: transcription matched skip phrase.`,
          );
          if (writeLogs) {
            await writeChapterLog(tmpDir, outputPath, [
              `Chapter: ${chapter.index + 1} - ${chapter.title}`,
              `Input: ${inputPath}`,
              `Duration: ${formatSeconds(duration)}`,
              `Trimmed duration: ${formatSeconds(trimmedDuration)}`,
              "Reason: Transcription matched skip phrase.",
            ]);
            summary.logsWritten += 1;
          }
          await safeUnlink(outputPath);
          continue;
        }
      }

      await extractChapterSegment({
        inputPath: normalizedPath,
        outputPath,
        start: paddedStart,
        end: paddedEnd,
      });

      summary.processed += 1;
    } finally {
      if (!keepIntermediates) {
        await safeUnlink(rawPath);
        await safeUnlink(normalizedPath);
        await safeUnlink(transcriptionAudioPath);
        await safeUnlink(transcriptionTextPath);
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
    `Skipped (transcription): ${summary.skippedTranscription}`,
    `Fallback notes: ${summary.fallbackNotes}`,
    `Log files written: ${summary.logsWritten}`,
  ];
  if (summaryDetails.length > 0) {
    summaryLines.push("Details:", ...summaryDetails);
  }

  logInfo("Summary:");
  summaryLines.forEach((line) => logInfo(line));

  if (writeLogs) {
    const summaryLogPath = buildSummaryLogPath(tmpDir);
    if (dryRun) {
      logInfo(`[dry-run] Would write summary log: ${summaryLogPath}`);
    } else {
      await Bun.write(summaryLogPath, `${summaryLines.join("\n")}\n`);
    }
  }
}

function parseCliArgs() {
  const rawArgs = hideBin(process.argv);
  const defaultWhisperModelPath = getDefaultWhisperModelPath();
  const parser = yargs(rawArgs)
    .scriptName("process-course-video")
    .usage(
      "Usage: $0 <input.mp4|input.mkv> [output-dir] [--min-chapter-seconds <number>] [--dry-run] [--keep-intermediates] [--write-logs] [--enable-transcription]",
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
            default: DEFAULT_MIN_CHAPTER_SECONDS,
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
          .option("enable-transcription", {
            type: "boolean",
            describe: "Enable whisper.cpp transcription skip checks",
            default: false,
          })
          .option("whisper-model-path", {
            type: "string",
            describe: "Path to whisper.cpp model file",
            default: defaultWhisperModelPath,
          })
          .option("whisper-language", {
            type: "string",
            describe: "Language passed to whisper.cpp",
            default: "en",
          })
          .option("whisper-binary-path", {
            type: "string",
            describe: "Path to whisper.cpp CLI (whisper-cli)",
          })
          .option("whisper-skip-phrase", {
            type: "string",
            array: true,
            describe:
              "Phrase to skip chapters when found in transcript (repeatable)",
            default: TRANSCRIPTION_PHRASES,
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
    return { shouldExit: true } as const;
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

  const minChapterDurationSeconds = Number(argv["min-chapter-seconds"]);
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
    enableTranscription: Boolean(argv["enable-transcription"]),
    whisperModelPath:
      typeof argv["whisper-model-path"] === "string" &&
      argv["whisper-model-path"].trim().length > 0
        ? argv["whisper-model-path"]
        : defaultWhisperModelPath,
    whisperLanguage:
      typeof argv["whisper-language"] === "string" &&
      argv["whisper-language"].trim().length > 0
        ? argv["whisper-language"].trim()
        : "en",
    whisperBinaryPath:
      typeof argv["whisper-binary-path"] === "string" &&
      argv["whisper-binary-path"].trim().length > 0
        ? argv["whisper-binary-path"].trim()
        : undefined,
    whisperSkipPhrases: normalizeSkipPhrases(argv["whisper-skip-phrase"]),
    chapterSelection:
      argv.chapter === undefined ? null : parseChapterSelection(argv.chapter),
    shouldExit: false,
  } as const;
}

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
  const clipDuration = chapterEnd - chapterStart;
  if (clipDuration <= 0) {
    return speechFallback(duration, "Invalid chapter boundaries; using full chapter.");
  }

  const samples = await readAudioSamples({
    inputPath,
    start: chapterStart,
    duration: clipDuration,
    sampleRate: CONFIG.vadSampleRate,
  });
  const fallbackNote = `Speech detection failed near ${formatSeconds(chapterStart)}; using full chapter.`;
  if (samples.length === 0) {
    return speechFallback(duration, fallbackNote);
  }

  const vadSegments = await detectSpeechSegmentsWithVad(
    samples,
    CONFIG.vadSampleRate,
    CONFIG,
  );
  if (vadSegments.length === 0) {
    return speechFallback(duration, fallbackNote);
  }
  const firstSegment = vadSegments[0];
  const lastSegment = vadSegments[vadSegments.length - 1];
  if (!firstSegment || !lastSegment) {
    return speechFallback(duration, fallbackNote);
  }
  const speechStart = firstSegment.start;
  const speechEnd = lastSegment.end;

  if (speechEnd <= speechStart + 0.1) {
    return speechFallback(duration, fallbackNote);
  }

  return { start: speechStart, end: speechEnd };
}

function speechFallback(duration: number, note: string): SpeechBounds {
  return { start: 0, end: duration, note };
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

async function extractTranscriptionAudio(options: {
  inputPath: string;
  outputPath: string;
  start: number;
  end: number;
}) {
  const clipDuration = options.end - options.start;
  if (clipDuration <= 0) {
    throw new Error(
      `Invalid transcription window (${formatSeconds(options.start)} -> ${formatSeconds(
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
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "1",
    "-ar",
    String(TRANSCRIPTION_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
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

function buildIntermediatePath(
  tmpDir: string,
  outputPath: string,
  suffix: string,
) {
  const parsed = path.parse(outputPath);
  return path.join(tmpDir, `${parsed.name}-${suffix}${parsed.ext}`);
}

function buildIntermediateAudioPath(
  tmpDir: string,
  outputPath: string,
  suffix: string,
) {
  const parsed = path.parse(outputPath);
  return path.join(tmpDir, `${parsed.name}-${suffix}.wav`);
}

function buildTranscriptionOutputBase(tmpDir: string, outputPath: string) {
  const parsed = path.parse(outputPath);
  return path.join(tmpDir, `${parsed.name}-transcribe`);
}

function buildSummaryLogPath(tmpDir: string) {
  return path.join(tmpDir, "process-summary.log");
}

function buildChapterLogPath(tmpDir: string, outputPath: string) {
  const parsed = path.parse(outputPath);
  return path.join(tmpDir, `${parsed.name}.log`);
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

function matchesTranscriptionPhrase(transcript: string, phrases: string[]) {
  return phrases.some((phrase) => transcript.toLowerCase().includes(phrase.toLowerCase()));
}

function normalizeSkipPhrases(rawPhrases: unknown) {
  const rawList = Array.isArray(rawPhrases) ? rawPhrases : [rawPhrases];
  const phrases = rawList
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.toLowerCase());

  return phrases.length > 0 ? phrases : TRANSCRIPTION_PHRASES;
}

function countTranscriptWords(transcript: string) {
  if (!transcript.trim()) {
    return 0;
  }
  return transcript.trim().split(/\s+/).length;
}

async function writeChapterLog(
  tmpDir: string,
  outputPath: string,
  lines: string[],
) {
  const logPath = buildChapterLogPath(tmpDir, outputPath);
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
