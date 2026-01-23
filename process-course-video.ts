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
  type TranscriptSegment,
} from "./whispercpp-transcribe";
import {
  clamp,
  formatCommand,
  formatSeconds,
  normalizeFilename,
  runCommand as runCommandBase,
  runCommandBinary as runCommandBinaryBase,
  toKebabCase,
} from "./utils";

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

type TimeRange = {
  start: number;
  end: number;
};

type SilenceBoundaryDirection = "before" | "after";

type TranscriptWord = {
  word: string;
  start: number;
  end: number;
};

type TranscriptCommand = {
  type: "bad-take" | "filename" | "nevermind" | "edit";
  value?: string;
  window: TimeRange;
};

type JarvisWarning = {
  chapter: Chapter;
  outputPath: string;
};

type JarvisEdit = {
  chapter: Chapter;
  outputPath: string;
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
  postSpeechPaddingSeconds: 0.35,
  rawTrimPaddingSeconds: 0.1,
  vadSampleRate: 16000,
  vadWindowSamples: 512,
  vadSpeechThreshold: 0.65,
  vadNegThreshold: 0.55,
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
  commandTrimPaddingSeconds: 0.25,
  commandSpliceReencode: true,
  commandSilenceSearchSeconds: 0.6,
  commandSilenceMinDurationMs: 120,
  commandSilenceRmsWindowMs: 6,
  commandSilenceRmsThreshold: 0.035,
  commandSilenceMaxBackwardSeconds: 0.2,
  commandTailMaxSeconds: 12,
};

const DEFAULT_MIN_CHAPTER_SECONDS = 15;
const TRANSCRIPTION_PHRASES = ["jarvis bad take", "bad take jarvis"];
const COMMAND_WAKE_WORD = "jarvis";
const COMMAND_CLOSE_WORD = "thanks";
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
    jarvisWarnings: 0,
  };
  const summaryDetails: string[] = [];
  const jarvisWarnings: JarvisWarning[] = [];
  const jarvisEdits: JarvisEdit[] = [];

  for (const chapter of selectedChapters) {
    const duration = chapter.end - chapter.start;
    if (duration <= 0) {
      throw new Error(
        `Invalid chapter duration for "${chapter.title}" (${duration}s)`,
      );
    }

    const outputBasePath = path.join(
      outputDir,
      `${formatChapterFilename(chapter)}${path.extname(inputPath)}`,
    );
    const rawPath = buildIntermediatePath(tmpDir, outputBasePath, "raw");
    const normalizedPath = buildIntermediatePath(
      tmpDir,
      outputBasePath,
      "normalized",
    );
    const transcriptionAudioPath = buildIntermediateAudioPath(
      tmpDir,
      outputBasePath,
      "transcribe",
    );
    const transcriptionOutputBase = buildTranscriptionOutputBase(
      tmpDir,
      outputBasePath,
    );
    const transcriptionTextPath = `${transcriptionOutputBase}.txt`;
    const transcriptionJsonPath = `${transcriptionOutputBase}.json`;
    const jarvisTranscriptionAudioPath = buildIntermediateAudioPath(
      tmpDir,
      outputBasePath,
      "jarvis",
    );
    const jarvisTranscriptionOutputBase = buildJarvisOutputBase(
      tmpDir,
      outputBasePath,
    );
    const jarvisTranscriptionTextPath = `${jarvisTranscriptionOutputBase}.txt`;
    const jarvisTranscriptionJsonPath = `${jarvisTranscriptionOutputBase}.json`;
    const spliceSegmentPaths: string[] = [];
    let splicedPath: string | null = null;

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
            `[dry-run] Would write log: ${buildChapterLogPath(tmpDir, outputBasePath)}`,
          );
        } else {
          await writeChapterLog(tmpDir, outputBasePath, [
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

      // Normalize audio before transcription
      const analysis = await analyzeLoudness(rawPath, 0, rawDuration);

      await renderChapter({
        inputPath: rawPath,
        outputPath: normalizedPath,
        absoluteStart: 0,
        absoluteEnd: rawDuration,
        analysis,
      });

      let finalOutputPath = outputBasePath;
      let commandWindows: TimeRange[] = [];
      let commandFilenameOverride: string | null = null;
      let hasEditCommand = false;

      if (enableTranscription) {
        await extractTranscriptionAudio({
          inputPath: normalizedPath,
          outputPath: transcriptionAudioPath,
          start: 0,
          end: rawDuration,
        });
        const transcriptionResult = await transcribeAudio(
          transcriptionAudioPath,
          {
            modelPath: whisperModelPath,
            language: whisperLanguage,
            binaryPath: whisperBinaryPath,
            outputBasePath: transcriptionOutputBase,
          },
        );
        const transcript = transcriptionResult.text;
        const scaledSegments =
          transcriptionResult.segmentsSource === "tokens"
            ? transcriptionResult.segments
            : scaleTranscriptSegments(transcriptionResult.segments, rawDuration);
        const commands = extractTranscriptCommands(scaledSegments, {
          wakeWord: COMMAND_WAKE_WORD,
          closeWord: COMMAND_CLOSE_WORD,
        });
        if (commands.length > 0) {
          logInfo(
            `Commands detected: ${commands.map((command) => command.type).join(", ")}`,
          );
        }
        const filenameCommand = commands.find(
          (command) => command.type === "filename" && command.value?.trim(),
        );
        if (filenameCommand?.value) {
          commandFilenameOverride = filenameCommand.value;
          logInfo(`Filename command: ${commandFilenameOverride}`);
        }
        const hasBadTakeCommand = commands.some(
          (command) => command.type === "bad-take",
        );
        hasEditCommand = commands.some(
          (command) => command.type === "edit",
        );
        const transcriptWordCount = countTranscriptWords(transcript);
        if (transcriptWordCount <= 10 && commands.length === 0) {
          summary.skippedTranscription += 1;
          summaryDetails.push(
            `Skipped chapter ${chapter.index + 1} (transcript too short).`,
          );
          logInfo(
            `Skipping chapter ${chapter.index + 1}: transcript too short (${transcriptWordCount} words).`,
          );
          if (writeLogs) {
            await writeChapterLog(tmpDir, outputBasePath, [
              `Chapter: ${chapter.index + 1} - ${chapter.title}`,
              `Input: ${inputPath}`,
              `Duration: ${formatSeconds(duration)}`,
              `Transcript words: ${transcriptWordCount}`,
              "Reason: Transcript too short.",
            ]);
            summary.logsWritten += 1;
          }
          await safeUnlink(outputBasePath);
          continue;
        }
        if (hasBadTakeCommand) {
          summary.skippedTranscription += 1;
          summaryDetails.push(
            `Skipped chapter ${chapter.index + 1} (bad take command detected).`,
          );
          logInfo(
            `Skipping chapter ${chapter.index + 1}: bad take command detected.`,
          );
          if (writeLogs) {
            await writeChapterLog(tmpDir, outputBasePath, [
              `Chapter: ${chapter.index + 1} - ${chapter.title}`,
              `Input: ${inputPath}`,
              `Duration: ${formatSeconds(duration)}`,
              "Reason: Bad take command detected.",
            ]);
            summary.logsWritten += 1;
          }
          await safeUnlink(outputBasePath);
          continue;
        }

        commandWindows = buildCommandWindows(commands, {
          offset: 0,
          min: 0,
          max: rawDuration,
          paddingSeconds: CONFIG.commandTrimPaddingSeconds,
        });
        if (commandWindows.length > 0) {
          commandWindows = await refineCommandWindows({
            commandWindows,
            inputPath: normalizedPath,
            duration: rawDuration,
          });
        }
      }

      const outputTitle = commandFilenameOverride ?? chapter.title;
      finalOutputPath = path.join(
        outputDir,
        `${formatChapterFilename({ ...chapter, title: outputTitle })}${path.extname(
          inputPath,
        )}`,
      );

      // Determine source path and duration after splicing (if any)
      let sourcePath = normalizedPath;
      let sourceDuration = rawDuration;

      if (commandWindows.length > 0) {
        const mergedCommandWindows = mergeTimeRanges(commandWindows);
        const keepRanges = buildKeepRanges(0, rawDuration, mergedCommandWindows);
        if (keepRanges.length === 0) {
          throw new Error("Command windows removed entire chapter.");
        }
        const isFullRange =
          keepRanges.length === 1 &&
          keepRanges[0] &&
          keepRanges[0].start <= 0.001 &&
          keepRanges[0].end >= rawDuration - 0.001;
        if (!isFullRange) {
          // Check if command is at end - just trim instead of splicing
          const isCommandAtEnd =
            keepRanges.length === 1 &&
            keepRanges[0] &&
            keepRanges[0].start <= 0.001;
          if (isCommandAtEnd && keepRanges[0]) {
            // Command at end - just trim to keep range
            sourceDuration = keepRanges[0].end;
            logInfo(
              `Command at end - trimming to ${formatSeconds(sourceDuration)}`,
            );
          } else {
            // Command mid-video - need to splice
            splicedPath = buildIntermediatePath(tmpDir, outputBasePath, "spliced");
            const segmentsWithSpeech: { path: string; range: TimeRange }[] = [];
            for (const [index, range] of keepRanges.entries()) {
              const segmentPath = buildIntermediatePath(
                tmpDir,
                outputBasePath,
                `splice-${index + 1}`,
              );
              spliceSegmentPaths.push(segmentPath);
              await extractChapterSegmentAccurate({
                inputPath: normalizedPath,
                outputPath: segmentPath,
                start: range.start,
                end: range.end,
              });
              // Check if segment has speech using VAD
              const segmentDuration = range.end - range.start;
              const hasSpeech = await checkSegmentHasSpeech(
                segmentPath,
                segmentDuration,
              );
              if (hasSpeech) {
                segmentsWithSpeech.push({ path: segmentPath, range });
              } else {
                logInfo(
                  `Splice segment ${index + 1} has no speech, excluding from combined output`,
                );
              }
            }
            if (segmentsWithSpeech.length === 0) {
              throw new Error("All splice segments have no speech.");
            }
            if (segmentsWithSpeech.length === 1 && segmentsWithSpeech[0]) {
              // Only one segment with speech - use it directly without concat
              sourcePath = segmentsWithSpeech[0].path;
              sourceDuration = segmentsWithSpeech[0].range.end - segmentsWithSpeech[0].range.start;
              splicedPath = null; // Don't delete the segment we're using
              logInfo(
                `Using single segment with speech, duration: ${formatSeconds(sourceDuration)}`,
              );
            } else {
              await concatSegments({
                segmentPaths: segmentsWithSpeech.map((s) => s.path),
                outputPath: splicedPath,
              });
              sourcePath = splicedPath;
              sourceDuration = segmentsWithSpeech.reduce(
                (total, s) => total + (s.range.end - s.range.start),
                0,
              );
              logInfo(
                `Spliced ${segmentsWithSpeech.length} segments (of ${keepRanges.length}), combined duration: ${formatSeconds(sourceDuration)}`,
              );
            }
          }
        }
      }

      // VAD speech bounds on final content
      const speechBounds = await detectSpeechBounds(
        sourcePath,
        0,
        sourceDuration,
        sourceDuration,
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
            outputBasePath,
            [
              `Chapter: ${chapter.index + 1} - ${chapter.title}`,
              `Input: ${inputPath}`,
              `Reason: ${speechBounds.note}`,
            ],
          );
          summary.logsWritten += 1;
        }
      }

      // Padded trim window
      const paddedStart = clamp(
        speechBounds.start - CONFIG.preSpeechPaddingSeconds,
        0,
        sourceDuration,
      );
      const paddedEnd = clamp(
        speechBounds.end + CONFIG.postSpeechPaddingSeconds,
        0,
        sourceDuration,
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

      if (trimmedDuration < minChapterDurationSeconds) {
        summary.skippedShortTrimmed += 1;
        summaryDetails.push(
          `Skipped chapter ${chapter.index + 1} (trimmed ${formatSeconds(
            trimmedDuration,
          )} < ${formatSeconds(minChapterDurationSeconds)}).`,
        );
        logInfo(
          `Skipping chapter ${chapter.index + 1}: trimmed ${formatSeconds(
            trimmedDuration,
          )} < ${formatSeconds(minChapterDurationSeconds)}.`,
        );
        if (writeLogs) {
          await writeChapterLog(tmpDir, outputBasePath, [
            `Chapter: ${chapter.index + 1} - ${chapter.title}`,
            `Input: ${inputPath}`,
            `Duration: ${formatSeconds(duration)}`,
            `Trimmed duration: ${formatSeconds(trimmedDuration)}`,
            `Skip threshold: ${formatSeconds(minChapterDurationSeconds)}`,
            "Reason: Trimmed duration shorter than minimum duration threshold.",
          ]);
          summary.logsWritten += 1;
        }
        await safeUnlink(outputBasePath);
        continue;
      }

      // Final chapter output
      await extractChapterSegment({
        inputPath: sourcePath,
        outputPath: finalOutputPath,
        start: paddedStart,
        end: paddedEnd,
      });

      if (!dryRun) {
        await extractTranscriptionAudio({
          inputPath: finalOutputPath,
          outputPath: jarvisTranscriptionAudioPath,
          start: 0,
          end: trimmedDuration,
        });
        const jarvisTranscription = await transcribeAudio(
          jarvisTranscriptionAudioPath,
          {
            modelPath: whisperModelPath,
            language: whisperLanguage,
            binaryPath: whisperBinaryPath,
            outputBasePath: jarvisTranscriptionOutputBase,
          },
        );
        if (transcriptIncludesWord(jarvisTranscription.text, "jarvis")) {
          jarvisWarnings.push({
            chapter,
            outputPath: finalOutputPath,
          });
          summary.jarvisWarnings += 1;
          logWarn(
            `Jarvis detected in chapter ${chapter.index + 1}: ${path.basename(
              finalOutputPath,
            )}`,
          );
        }
      }

      if (hasEditCommand) {
        jarvisEdits.push({
          chapter,
          outputPath: finalOutputPath,
        });
        logInfo(
          `Edit command detected for chapter ${chapter.index + 1}: ${path.basename(
            finalOutputPath,
          )}`,
        );
      }

      summary.processed += 1;
    } finally {
      if (!keepIntermediates) {
        await safeUnlink(rawPath);
        await safeUnlink(normalizedPath);
        await safeUnlink(transcriptionAudioPath);
        await safeUnlink(transcriptionTextPath);
        await safeUnlink(transcriptionJsonPath);
        await safeUnlink(jarvisTranscriptionAudioPath);
        await safeUnlink(jarvisTranscriptionTextPath);
        await safeUnlink(jarvisTranscriptionJsonPath);
        if (splicedPath) {
          await safeUnlink(splicedPath);
        }
        for (const segmentPath of spliceSegmentPaths) {
          await safeUnlink(segmentPath);
        }
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
    `Jarvis warnings: ${summary.jarvisWarnings}`,
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

  const jarvisWarningLogPath = buildJarvisWarningLogPath(outputDir);
  if (dryRun) {
    logInfo(`[dry-run] Would write jarvis warning log: ${jarvisWarningLogPath}`);
  } else {
    const warningLines = [
      `Input: ${inputPath}`,
      `Output dir: ${outputDir}`,
      `Jarvis warnings: ${jarvisWarnings.length}`,
    ];
    if (jarvisWarnings.length > 0) {
      warningLines.push("Detected in:");
      jarvisWarnings.forEach((warning) => {
        warningLines.push(
          `- Chapter ${warning.chapter.index + 1}: ${warning.chapter.title} -> ${path.basename(
            warning.outputPath,
          )}`,
        );
      });
    } else {
      warningLines.push("Detected in: none");
    }
    await Bun.write(jarvisWarningLogPath, `${warningLines.join("\n")}\n`);
  }

  const jarvisEditLogPath = buildJarvisEditLogPath(outputDir);
  if (dryRun) {
    logInfo(`[dry-run] Would write jarvis edit log: ${jarvisEditLogPath}`);
  } else {
    const editLines = [
      `Input: ${inputPath}`,
      `Output dir: ${outputDir}`,
      `Edit commands: ${jarvisEdits.length}`,
    ];
    if (jarvisEdits.length > 0) {
      editLines.push("Files needing edits:");
      jarvisEdits.forEach((edit) => {
        editLines.push(
          `- Chapter ${edit.chapter.index + 1}: ${edit.chapter.title} -> ${path.basename(
            edit.outputPath,
          )}`,
        );
      });
    } else {
      editLines.push("Files needing edits: none");
    }
    await Bun.write(jarvisEditLogPath, `${editLines.join("\n")}\n`);
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

async function refineCommandWindows(options: {
  commandWindows: TimeRange[];
  inputPath: string;
  duration: number;
}) {
  if (options.commandWindows.length === 0) {
    return [];
  }
  const refined: TimeRange[] = [];
  for (const window of options.commandWindows) {
    const shouldKeepStart = await isSilenceAtTarget({
      inputPath: options.inputPath,
      duration: options.duration,
      targetTime: window.start,
      label: "start",
    });
    let refinedStart = shouldKeepStart
      ? window.start
      : await findSilenceBoundary({
          inputPath: options.inputPath,
          duration: options.duration,
          targetTime: window.start,
          direction: "before",
          maxSearchSeconds: CONFIG.commandSilenceSearchSeconds,
        });
    if (
      refinedStart !== null &&
      window.start - refinedStart > CONFIG.commandSilenceMaxBackwardSeconds
    ) {
      refinedStart = window.start;
    }
    const shouldKeepEnd = await isSilenceAtTarget({
      inputPath: options.inputPath,
      duration: options.duration,
      targetTime: window.end,
      label: "end",
    });
    const refinedEnd = shouldKeepEnd
      ? window.end
      : await findSilenceBoundary({
          inputPath: options.inputPath,
          duration: options.duration,
          targetTime: window.end,
          direction: "after",
          maxSearchSeconds: CONFIG.commandSilenceSearchSeconds,
        });
    const start = clamp(
      refinedStart ?? window.start,
      0,
      options.duration,
    );
    const end = clamp(refinedEnd ?? window.end, 0, options.duration);
    if (end <= start + 0.01) {
      refined.push({ start: window.start, end: window.end });
      continue;
    }
    if (
      Math.abs(start - window.start) > 0.01 ||
      Math.abs(end - window.end) > 0.01
    ) {
      logInfo(
        `Refined command window ${formatSeconds(window.start)}-${formatSeconds(
          window.end,
        )} to ${formatSeconds(start)}-${formatSeconds(end)}`,
      );
    }
    refined.push({ start, end });
  }
  return mergeTimeRanges(refined);
}

async function findSilenceBoundary(options: {
  inputPath: string;
  duration: number;
  targetTime: number;
  direction: SilenceBoundaryDirection;
  maxSearchSeconds: number;
}) {
  const searchStart =
    options.direction === "before"
      ? Math.max(0, options.targetTime - options.maxSearchSeconds)
      : options.targetTime;
  const searchEnd =
    options.direction === "before"
      ? options.targetTime
      : Math.min(options.duration, options.targetTime + options.maxSearchSeconds);
  const searchDuration = searchEnd - searchStart;
  if (searchDuration <= 0.05) {
    return null;
  }
  const samples = await readAudioSamples({
    inputPath: options.inputPath,
    start: searchStart,
    duration: searchDuration,
    sampleRate: CONFIG.vadSampleRate,
  });
  if (samples.length === 0) {
    return null;
  }

  const targetOffset = options.targetTime - searchStart;
  let boundary =
    (await findSilenceBoundaryWithVad({
      samples,
      duration: searchDuration,
      targetOffset,
      direction: options.direction,
    })) ??
    findSilenceBoundaryWithRms({
      samples,
      sampleRate: CONFIG.vadSampleRate,
      direction: options.direction,
      rmsWindowMs: CONFIG.commandSilenceRmsWindowMs,
      rmsThreshold: CONFIG.commandSilenceRmsThreshold,
      minSilenceMs: CONFIG.commandSilenceMinDurationMs,
    });
  if (boundary === null || !Number.isFinite(boundary)) {
    return null;
  }
  boundary = clamp(boundary, 0, searchDuration);
  return searchStart + boundary;
}

async function isSilenceAtTarget(options: {
  inputPath: string;
  duration: number;
  targetTime: number;
  label?: string;
}) {
  const halfWindowSeconds = Math.max(
    0.005,
    (CONFIG.commandSilenceRmsWindowMs / 1000) * 1.5,
  );
  const windowStart = clamp(
    options.targetTime - halfWindowSeconds,
    0,
    options.duration,
  );
  const windowEnd = clamp(
    options.targetTime + halfWindowSeconds,
    0,
    options.duration,
  );
  const windowDuration = windowEnd - windowStart;
  if (windowDuration <= 0.01) {
    return false;
  }
  const samples = await readAudioSamples({
    inputPath: options.inputPath,
    start: windowStart,
    duration: windowDuration,
    sampleRate: CONFIG.vadSampleRate,
  });
  if (samples.length === 0) {
    return false;
  }
  const windowSamples = Math.max(
    1,
    Math.round((CONFIG.vadSampleRate * CONFIG.commandSilenceRmsWindowMs) / 1000),
  );
  const rms = computeRms(samples);
  const minRms = computeMinWindowRms(samples, windowSamples);
  const label = options.label ? ` ${options.label}` : "";
  logInfo(
    `Command window${label} RMS at ${formatSeconds(options.targetTime)}: avg ${rms.toFixed(
      4,
    )}, min ${minRms.toFixed(4)} (threshold ${CONFIG.commandSilenceRmsThreshold})`,
  );
  return minRms < CONFIG.commandSilenceRmsThreshold;
}

async function findSilenceBoundaryWithVad(options: {
  samples: Float32Array;
  duration: number;
  targetOffset: number;
  direction: SilenceBoundaryDirection;
}) {
  try {
    const vadSegments = await detectSpeechSegmentsWithVad(
      options.samples,
      CONFIG.vadSampleRate,
      CONFIG,
    );
    if (vadSegments.length === 0) {
      return null;
    }
    const silenceGaps = buildSilenceGapsFromSpeech(
      vadSegments,
      options.duration,
    );
    return findSilenceBoundaryFromGaps(
      silenceGaps,
      options.targetOffset,
      options.direction,
    );
  } catch (error) {
    logInfo(
      `VAD silence scan failed (${options.direction}); using RMS fallback.`,
    );
    return null;
  }
}

function findSilenceBoundaryWithRms(options: {
  samples: Float32Array;
  sampleRate: number;
  direction: SilenceBoundaryDirection;
  rmsWindowMs: number;
  rmsThreshold: number;
  minSilenceMs: number;
}) {
  const windowSamples = Math.max(
    1,
    Math.round((options.sampleRate * options.rmsWindowMs) / 1000),
  );
  const minSilentWindows = Math.max(
    1,
    Math.round(options.minSilenceMs / options.rmsWindowMs),
  );
  const totalWindows = Math.floor(options.samples.length / windowSamples);
  if (totalWindows === 0) {
    return null;
  }
  const isSilent: boolean[] = [];
  for (let index = 0; index < totalWindows; index += 1) {
    const offset = index * windowSamples;
    let sumSquares = 0;
    for (let i = 0; i < windowSamples; i += 1) {
      const sample = options.samples[offset + i] ?? 0;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / windowSamples);
    isSilent.push(rms < options.rmsThreshold);
  }

  const windowSeconds = windowSamples / options.sampleRate;
  if (options.direction === "before") {
    let run = 0;
    for (let index = totalWindows - 1; index >= 0; index -= 1) {
      if (isSilent[index]) {
        run += 1;
        if (run >= minSilentWindows) {
          const boundaryIndex = index + run;
          return boundaryIndex * windowSeconds;
        }
      } else {
        run = 0;
      }
    }
  } else {
    let run = 0;
    for (let index = 0; index < totalWindows; index += 1) {
      if (isSilent[index]) {
        run += 1;
        if (run >= minSilentWindows) {
          const runStart = index - run + 1;
          return runStart * windowSeconds;
        }
      } else {
        run = 0;
      }
    }
  }

  return null;
}

function computeRms(samples: Float32Array) {
  if (samples.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function computeMinWindowRms(samples: Float32Array, windowSamples: number) {
  if (samples.length === 0 || windowSamples <= 0) {
    return 0;
  }
  if (samples.length <= windowSamples) {
    return computeRms(samples);
  }
  let minRms = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset + windowSamples <= samples.length; offset += 1) {
    let sumSquares = 0;
    for (let i = 0; i < windowSamples; i += 1) {
      const sample = samples[offset + i] ?? 0;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / windowSamples);
    if (rms < minRms) {
      minRms = rms;
    }
  }
  return Number.isFinite(minRms) ? minRms : 0;
}

function buildSilenceGapsFromSpeech(speechSegments: TimeRange[], duration: number) {
  const gaps: TimeRange[] = [];
  let cursor = 0;
  for (const segment of speechSegments) {
    if (segment.start > cursor) {
      gaps.push({ start: cursor, end: segment.start });
    }
    cursor = Math.max(cursor, segment.end);
  }
  if (cursor < duration) {
    gaps.push({ start: cursor, end: duration });
  }
  return gaps.filter((gap) => gap.end > gap.start + 0.001);
}

function findSilenceBoundaryFromGaps(
  gaps: TimeRange[],
  targetOffset: number,
  direction: SilenceBoundaryDirection,
) {
  for (const gap of gaps) {
    if (targetOffset >= gap.start && targetOffset <= gap.end) {
      return targetOffset;
    }
  }
  if (direction === "before") {
    let boundary: number | null = null;
    for (const gap of gaps) {
      if (gap.end <= targetOffset + 0.001) {
        boundary = gap.end;
      }
    }
    return boundary;
  }
  for (const gap of gaps) {
    if (gap.start >= targetOffset - 0.001) {
      return gap.start;
    }
  }
  return null;
}

function speechFallback(duration: number, note: string): SpeechBounds {
  return { start: 0, end: duration, note };
}

async function checkSegmentHasSpeech(
  inputPath: string,
  duration: number,
): Promise<boolean> {
  if (duration <= 0) {
    return false;
  }

  const samples = await readAudioSamples({
    inputPath,
    start: 0,
    duration,
    sampleRate: CONFIG.vadSampleRate,
  });
  if (samples.length === 0) {
    return false;
  }

  const vadSegments = await detectSpeechSegmentsWithVad(
    samples,
    CONFIG.vadSampleRate,
    CONFIG,
  );
  return vadSegments.length > 0;
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

async function extractChapterSegmentAccurate(options: {
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
    "-i",
    options.inputPath,
    "-ss",
    options.start.toFixed(3),
    "-t",
    clipDuration.toFixed(3),
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
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-c:a",
    CONFIG.audioCodec,
    "-b:a",
    CONFIG.audioBitrate,
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
  return runCommandBase(command, { allowFailure, logCommand });
}

async function runCommandBinary(command: string[], allowFailure = false) {
  return runCommandBinaryBase(command, { allowFailure, logCommand });
}

function logCommand(command: string[]) {
  console.log(`[cmd] ${formatCommand(command)}`);
}

function logInfo(message: string) {
  console.log(`[info] ${message}`);
}

function logWarn(message: string) {
  console.warn(`[warn] ${message}`);
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

function buildJarvisOutputBase(tmpDir: string, outputPath: string) {
  const parsed = path.parse(outputPath);
  return path.join(tmpDir, `${parsed.name}-jarvis`);
}

function buildSummaryLogPath(tmpDir: string) {
  return path.join(tmpDir, "process-summary.log");
}

function buildJarvisWarningLogPath(outputDir: string) {
  return path.join(outputDir, "jarvis-warnings.log");
}

function buildJarvisEditLogPath(outputDir: string) {
  return path.join(outputDir, "jarvis-edits.log");
}

function buildChapterLogPath(tmpDir: string, outputPath: string) {
  const parsed = path.parse(outputPath);
  return path.join(tmpDir, `${parsed.name}.log`);
}

function formatChapterFilename(chapter: Chapter) {
  const title = chapter.title ?? `chapter-${chapter.index + 1}`;
  const normalized = normalizeFilename(title);
  const slug = toKebabCase(normalized);
  return `chapter-${String(chapter.index + 1).padStart(2, "0")}-${slug}`;
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

function transcriptIncludesWord(transcript: string, word: string) {
  if (!transcript.trim()) {
    return false;
  }
  const normalized = normalizeWords(transcript);
  return normalized.includes(word.toLowerCase());
}

function scaleTranscriptSegments(
  segments: TranscriptSegment[],
  duration: number,
) {
  if (segments.length === 0) {
    return segments;
  }
  const candidates = segments.filter((segment) => /[a-z0-9]/i.test(segment.text));
  const maxEnd = Math.max(
    ...(candidates.length > 0 ? candidates : segments).map((segment) => segment.end),
  );
  if (!Number.isFinite(maxEnd) || maxEnd <= 0) {
    return segments;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return segments;
  }
  const scale = duration / maxEnd;
  if (!Number.isFinite(scale) || Math.abs(scale - 1) < 0.02) {
    return segments;
  }
  return segments.map((segment) => ({
    ...segment,
    start: segment.start * scale,
    end: segment.end * scale,
  }));
}

function extractTranscriptCommands(
  segments: TranscriptSegment[],
  options: { wakeWord: string; closeWord: string },
): TranscriptCommand[] {
  const words = buildTranscriptWords(segments);
  if (words.length === 0) {
    return [];
  }
  const commands: TranscriptCommand[] = [];
  const wakeWord = options.wakeWord.toLowerCase();
  const closeWord = options.closeWord.toLowerCase();
  let index = 0;
  while (index < words.length) {
    const startWord = words[index];
    if (!startWord || startWord.word !== wakeWord) {
      index += 1;
      continue;
    }
    const nextWord = words[index + 1];
    // Check for nevermind cancellation pattern: jarvis ... nevermind ... thanks
    if (nextWord) {
      let nevermindIndex = index + 1;
      let foundNevermind = false;
      while (nevermindIndex < words.length) {
        const word = words[nevermindIndex];
        if (!word) {
          break;
        }
        // Check for "nevermind" as one word
        if (word.word === "nevermind") {
          foundNevermind = true;
          break;
        }
        // Check for "never mind" as two consecutive words
        if (word.word === "never" && nevermindIndex + 1 < words.length) {
          const nextWordAfterNever = words[nevermindIndex + 1];
          if (nextWordAfterNever && nextWordAfterNever.word === "mind") {
            foundNevermind = true;
            break;
          }
        }
        if (word.word === closeWord) {
          break;
        }
        nevermindIndex += 1;
      }
      if (foundNevermind) {
        // Look for the close word after nevermind
        // If nevermind was two words, skip past both
        const searchStartIndex =
          words[nevermindIndex]?.word === "never" &&
          nevermindIndex + 1 < words.length &&
          words[nevermindIndex + 1]?.word === "mind"
            ? nevermindIndex + 2
            : nevermindIndex + 1;
        let endIndex = searchStartIndex;
        while (endIndex < words.length && words[endIndex]?.word !== closeWord) {
          endIndex += 1;
        }
        const endWord = words[endIndex];
        if (endWord && endWord.word === closeWord) {
          // Found jarvis ... nevermind ... thanks pattern - remove it
          commands.push({
            type: "nevermind",
            window: {
              start: startWord.start,
              end: endWord.end,
            },
          });
          index = endIndex + 1;
          continue;
        }
      }
    }
    // Check for regular commands with command starters
    if (!nextWord || !isCommandStarter(nextWord.word)) {
      index += 1;
      continue;
    }
    let endIndex = index + 1;
    while (endIndex < words.length && words[endIndex]?.word !== closeWord) {
      endIndex += 1;
    }
    let endWord = words[endIndex];
    const hasCloseWord = endIndex < words.length && endWord?.word === closeWord;
    if (!hasCloseWord) {
      const fallbackEndWord = words[words.length - 1];
      if (!fallbackEndWord) {
        break;
      }
      const tailDuration = fallbackEndWord.end - startWord.start;
      if (tailDuration > CONFIG.commandTailMaxSeconds) {
        index += 1;
        continue;
      }
      endWord = fallbackEndWord;
      endIndex = words.length;
    }
    if (!endWord) {
      index += 1;
      continue;
    }
    const commandWords = words
      .slice(index + 1, endIndex)
      .map((item) => item.word)
      .filter(Boolean);
    if (commandWords.length > 0) {
      const command = parseCommand(commandWords, {
        start: startWord.start,
        end: endWord.end,
      });
      if (command) {
        commands.push(command);
      }
    }
    index = hasCloseWord ? endIndex + 1 : words.length;
  }
  return commands;
}

function parseCommand(words: string[], window: TimeRange): TranscriptCommand | null {
  if (words.length >= 2 && words[0] === "bad" && words[1] === "take") {
    return { type: "bad-take", window };
  }
  if (words[0] === "filename") {
    const value = words.slice(1).join(" ").trim();
    if (!value) {
      return null;
    }
    return { type: "filename", value, window };
  }
  if (words.length >= 2 && words[0] === "file" && words[1] === "name") {
    const value = words.slice(2).join(" ").trim();
    if (!value) {
      return null;
    }
    return { type: "filename", value, window };
  }
  if (words[0] === "edit") {
    return { type: "edit", window };
  }
  return null;
}

function isCommandStarter(word: string) {
  return word === "bad" || word === "filename" || word === "file" || word === "edit";
}

function buildTranscriptWords(segments: TranscriptSegment[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  for (const segment of ordered) {
    const segmentWords = normalizeWords(segment.text);
    if (segmentWords.length === 0) {
      continue;
    }
    const segmentDuration = Math.max(segment.end - segment.start, 0);
    const wordDuration =
      segmentWords.length > 0 ? segmentDuration / segmentWords.length : 0;
    for (const [index, word] of segmentWords.entries()) {
      const start = segment.start + wordDuration * index;
      const end =
        index === segmentWords.length - 1
          ? segment.end
          : segment.start + wordDuration * (index + 1);
      words.push({ word, start, end });
    }
  }
  return words;
}

function normalizeWords(text: string) {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  if (normalized === "blank audio" || normalized === "blankaudio") {
    return [];
  }
  const words = normalized
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => {
      if (word === "jervis") {
        return ["jarvis"];
      }
      if (word === "badtake" || /^batte(ik|ke)$/.test(word)) {
        return ["bad", "take"];
      }
      return [word];
    });
  return words;
}

function buildCommandWindows(
  commands: TranscriptCommand[],
  options: { offset: number; min: number; max: number; paddingSeconds: number },
) {
  if (commands.length === 0) {
    return [];
  }
  const windows = commands
    .map((command) => {
      const start = clamp(
        options.offset + command.window.start - options.paddingSeconds,
        options.min,
        options.max,
      );
      const end = clamp(
        options.offset + command.window.end + options.paddingSeconds,
        options.min,
        options.max,
      );
      if (end <= start) {
        return null;
      }
      return { start, end };
    })
    .filter((window): window is TimeRange => Boolean(window));
  return mergeTimeRanges(windows);
}

function mergeTimeRanges(ranges: TimeRange[]) {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  let current = sorted[0];
  if (!current) {
    return [];
  }
  for (const range of sorted.slice(1)) {
    if (range.start <= current.end + 0.01) {
      current = { start: current.start, end: Math.max(current.end, range.end) };
    } else {
      merged.push(current);
      current = range;
    }
  }
  merged.push(current);
  return merged;
}

function buildKeepRanges(
  start: number,
  end: number,
  exclude: TimeRange[],
): TimeRange[] {
  if (exclude.length === 0) {
    return [{ start, end }];
  }
  const ranges: TimeRange[] = [];
  let cursor = start;
  for (const window of mergeTimeRanges(exclude)) {
    if (window.end <= cursor) {
      continue;
    }
    if (window.start > cursor) {
      ranges.push({ start: cursor, end: window.start });
    }
    cursor = Math.max(cursor, window.end);
  }
  if (cursor < end) {
    ranges.push({ start: cursor, end });
  }
  return ranges.filter((range) => range.end > range.start);
}

function sumRangeDuration(ranges: TimeRange[]) {
  return ranges.reduce((total, range) => total + (range.end - range.start), 0);
}

function adjustTimeForRemovedRanges(time: number, removed: TimeRange[]) {
  if (removed.length === 0) {
    return time;
  }
  let adjusted = time;
  for (const range of mergeTimeRanges(removed)) {
    if (range.end <= time) {
      adjusted -= range.end - range.start;
      continue;
    }
    if (range.start < time && range.end > time) {
      adjusted -= time - range.start;
      break;
    }
    break;
  }
  return adjusted;
}

async function concatSegments(options: {
  segmentPaths: string[];
  outputPath: string;
}) {
  if (options.segmentPaths.length < 2) {
    throw new Error("Splice requires at least two segments to concat.");
  }
  const args = ["ffmpeg", "-hide_banner", "-y"];
  for (const segmentPath of options.segmentPaths) {
    args.push("-i", segmentPath);
  }
  const inputLabels = options.segmentPaths
    .map((_, index) => `[${index}:v:0][${index}:a:0]`)
    .join("");
  const concatFilter = `${inputLabels}concat=n=${options.segmentPaths.length}:v=1:a=1[v][a]`;
  const filter = `${concatFilter};[a]aresample=async=1:first_pts=0[aout]`;
  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[aout]",
  );
  if (CONFIG.commandSpliceReencode) {
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18");
  } else {
    args.push("-c:v", "copy");
  }
  args.push("-c:a", CONFIG.audioCodec, "-b:a", CONFIG.audioBitrate);
  args.push(options.outputPath);
  await runCommand(args);
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
