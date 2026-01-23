import path from "node:path";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import type { Argv, Arguments } from "yargs";
import { getDefaultWhisperModelPath } from "../whispercpp-transcribe";
import {
  DEFAULT_MIN_CHAPTER_SECONDS,
  TRANSCRIPTION_PHRASES,
} from "./config";
import { normalizeSkipPhrases } from "./utils/transcript";
import { parseChapterSelection } from "./utils/chapter-selection";
import type { ChapterSelection } from "./types";

export interface CliArgs {
  inputPath: string;
  outputDir: string;
  minChapterDurationSeconds: number;
  dryRun: boolean;
  keepIntermediates: boolean;
  writeLogs: boolean;
  enableTranscription: boolean;
  whisperModelPath: string;
  whisperLanguage: string;
  whisperBinaryPath: string | undefined;
  whisperSkipPhrases: string[];
  chapterSelection: ChapterSelection | null;
  shouldExit: boolean;
}

export function parseCliArgs(): CliArgs {
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
            default: true,
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
    return {
      inputPath: "",
      outputDir: "",
      minChapterDurationSeconds: DEFAULT_MIN_CHAPTER_SECONDS,
      dryRun: false,
      keepIntermediates: false,
      writeLogs: false,
      enableTranscription: true,
      whisperModelPath: defaultWhisperModelPath,
      whisperLanguage: "en",
      whisperBinaryPath: undefined,
      whisperSkipPhrases: TRANSCRIPTION_PHRASES,
      chapterSelection: null,
      shouldExit: true,
    };
  }

  const argv = parser.parseSync();

  const inputPath = typeof argv.input === "string" ? argv.input : "";
  if (!inputPath) {
    throw new Error("Input file is required.");
  }

  const outputDir =
    typeof argv.outputDir === "string" && argv.outputDir.trim().length > 0
      ? argv.outputDir
      : path.parse(inputPath).name;

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
  } as CliArgs;
}
