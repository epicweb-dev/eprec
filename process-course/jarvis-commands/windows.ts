import { clamp } from "../../utils";
import { detectSpeechSegmentsWithVad } from "../../speech-detection";
import { readAudioSamples } from "../ffmpeg";
import { CONFIG } from "../config";
import { logInfo } from "../logging";
import { formatSeconds } from "../../utils";
import { mergeTimeRanges } from "../utils/time-ranges";
import {
  buildSilenceGapsFromSpeech,
  findSilenceBoundaryFromGaps,
  findSilenceBoundaryWithRms,
  computeRms,
  computeMinWindowRms,
} from "../utils/audio-analysis";
import type { TimeRange, SilenceBoundaryDirection } from "../types";
import type { TranscriptCommand, CommandWindowOptions } from "./types";

/**
 * Build time windows to remove based on detected commands.
 */
export function buildCommandWindows(
  commands: TranscriptCommand[],
  options: CommandWindowOptions,
): TimeRange[] {
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

/**
 * Refine command windows to align with silence boundaries.
 */
export async function refineCommandWindows(options: {
  commandWindows: TimeRange[];
  inputPath: string;
  duration: number;
}): Promise<TimeRange[]> {
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
    const start = clamp(refinedStart ?? window.start, 0, options.duration);
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

export async function findSilenceBoundary(options: {
  inputPath: string;
  duration: number;
  targetTime: number;
  direction: SilenceBoundaryDirection;
  maxSearchSeconds: number;
}): Promise<number | null> {
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
}): Promise<boolean> {
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
}): Promise<number | null> {
  try {
    const vadSegments = await detectSpeechSegmentsWithVad(
      options.samples,
      CONFIG.vadSampleRate,
      CONFIG,
    );
    if (vadSegments.length === 0) {
      return null;
    }
    const silenceGaps = buildSilenceGapsFromSpeech(vadSegments, options.duration);
    return findSilenceBoundaryFromGaps(
      silenceGaps,
      options.targetOffset,
      options.direction,
    );
  } catch {
    logInfo(
      `VAD silence scan failed (${options.direction}); using RMS fallback.`,
    );
    return null;
  }
}
