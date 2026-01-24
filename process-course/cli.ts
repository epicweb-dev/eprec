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
  inputPaths: string[];
  outputDir: string | null;
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
}

export const PROCESS_USAGE =
  "Usage: $0 process <input.mp4|input.mkv> [input2.mp4 ...] [output-dir] [--output-dir <dir>] [--min-chapter-seconds <number>] [--dry-run] [--keep-intermediates] [--write-logs] [--enable-transcription]\n  If the last positional argument doesn't have a video extension, it's treated as the output directory.";

export function registerProcessCommand(
  yargsInstance: Argv,
  runProcess: (args: CliArgs) => Promise<void>,
): Argv {
  const defaultWhisperModelPath = getDefaultWhisperModelPath();

  return yargsInstance
    .command(
      "process <input...>",
      "Process chapters into separate files",
      (command: Argv) =>
        command
          .positional("input", {
            type: "string",
            array: true,
            describe: "Input video file(s)",
          })
          .option("output-dir", {
            type: "string",
            alias: "o",
            describe:
              "Output directory (optional - if not specified, creates directory next to each input file)",
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
      async (args: Arguments) => {
        const parsedArgs = parseProcessArgs(args, defaultWhisperModelPath);
        await runProcess(parsedArgs);
      },
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
    });
}

function parseProcessArgs(
  args: Arguments,
  defaultWhisperModelPath: string,
): CliArgs {
  let inputPaths = Array.isArray(args.input)
    ? args.input.filter((p): p is string => typeof p === "string")
    : typeof args.input === "string"
      ? [args.input]
      : [];

  // If output-dir is not explicitly set, check if the last positional arg
  // doesn't look like a video file (no video extension). If so, treat it as the output directory
  let outputDir =
    typeof args["output-dir"] === "string" &&
    args["output-dir"].trim().length > 0
      ? args["output-dir"]
      : null;

  if (!outputDir && inputPaths.length > 0) {
    const lastArg = inputPaths.at(-1) ?? null;
    if (lastArg !== null) {
      const videoExtensions = [
        ".mp4",
        ".mkv",
        ".avi",
        ".mov",
        ".webm",
        ".flv",
        ".m4v",
      ];
      const hasVideoExtension = videoExtensions.some((ext) =>
        lastArg.toLowerCase().endsWith(ext),
      );

      if (!hasVideoExtension) {
        // Last argument is likely the output directory
        outputDir = lastArg;
        inputPaths = inputPaths.slice(0, -1); // Remove the last argument from inputs
      }
    }
  }

  if (inputPaths.length === 0) {
    throw new Error("At least one input file is required.");
  }

  const minChapterDurationSeconds = Number(args["min-chapter-seconds"]);
  if (
    !Number.isFinite(minChapterDurationSeconds) ||
    minChapterDurationSeconds < 0
  ) {
    throw new Error("min-chapter-seconds must be a non-negative number.");
  }

  return {
    inputPaths,
    outputDir,
    minChapterDurationSeconds,
    dryRun: Boolean(args["dry-run"]),
    keepIntermediates: Boolean(args["keep-intermediates"]),
    writeLogs: Boolean(args["write-logs"]),
    enableTranscription: Boolean(args["enable-transcription"]),
    whisperModelPath:
      typeof args["whisper-model-path"] === "string" &&
      args["whisper-model-path"].trim().length > 0
        ? args["whisper-model-path"]
        : defaultWhisperModelPath,
    whisperLanguage:
      typeof args["whisper-language"] === "string" &&
      args["whisper-language"].trim().length > 0
        ? args["whisper-language"].trim()
        : "en",
    whisperBinaryPath:
      typeof args["whisper-binary-path"] === "string" &&
      args["whisper-binary-path"].trim().length > 0
        ? args["whisper-binary-path"].trim()
        : undefined,
    whisperSkipPhrases: normalizeSkipPhrases(args["whisper-skip-phrase"]),
    chapterSelection:
      args.chapter === undefined ? null : parseChapterSelection(args.chapter),
  } as CliArgs;
}
