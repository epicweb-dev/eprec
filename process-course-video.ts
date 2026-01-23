#!/usr/bin/env bun
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { detectSpeechBounds, checkSegmentHasSpeech } from "./speech-detection";
import { transcribeAudio } from "./whispercpp-transcribe";
import {
  COMMAND_CLOSE_WORD,
  COMMAND_WAKE_WORD,
  CONFIG,
} from "./process-course/config";
import {
  analyzeLoudness,
  concatSegments,
  ensureFfmpegAvailable,
  extractChapterSegment,
  extractChapterSegmentAccurate,
  extractTranscriptionAudio,
  getChapters,
  renderChapter,
} from "./process-course/ffmpeg";
import {
  buildChapterLogPath,
  buildIntermediateAudioPath,
  buildIntermediatePath,
  buildJarvisOutputBase,
  buildTranscriptionOutputBase,
} from "./process-course/paths";
import { logInfo, logWarn, writeChapterLog } from "./process-course/logging";
import { parseCliArgs } from "./process-course/cli";
import {
  buildCommandWindows,
  buildKeepRanges,
  buildSilenceGapsFromSpeech,
  computeMinWindowRms,
  computeRms,
  countTranscriptWords,
  extractTranscriptCommands,
  findSilenceBoundaryFromGaps,
  findSilenceBoundaryWithRms,
  formatChapterFilename,
  mergeTimeRanges,
  normalizeSkipPhrases,
  parseChapterSelection,
  resolveChapterSelection,
  scaleTranscriptSegments,
  safeUnlink,
  speechFallback,
  transcriptIncludesWord,
} from "./process-course/utils";
import { refineCommandWindows } from "./process-course/command-handling";
import { writeSummaryLogs, writeJarvisLogs } from "./process-course/summary";
import { detectSpeechSegmentsWithVad } from "./speech-detection";
import { readAudioSamples } from "./process-course/ffmpeg";
import type {
  Chapter,
  ChapterRange,
  ChapterSelection,
  JarvisEdit,
  JarvisWarning,
  LoudnormAnalysis,
  SilenceBoundaryDirection,
  SpeechBounds,
  TimeRange,
} from "./process-course/types";
import { clamp, formatSeconds } from "./utils";

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

  // Always write jarvis logs (summary information)
  await writeJarvisLogs({
    outputDir,
    inputPath,
    jarvisWarnings,
    jarvisEdits,
    dryRun,
  });

  // Only write detailed summary log when writeLogs is enabled
  if (writeLogs) {
    await writeSummaryLogs({
      tmpDir,
      outputDir,
      inputPath,
      summary,
      summaryDetails,
      jarvisWarnings,
      jarvisEdits,
      dryRun,
    });
  }
}

main().catch((error) => {
  console.error(`[error] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
