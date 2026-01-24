import { detectSpeechSegmentsWithVad } from "../../speech-detection";
import { readAudioSamples } from "../ffmpeg";
import { CONFIG, EDIT_CONFIG } from "../config";
import { clamp } from "../../utils";
import { mergeTimeRanges } from "../utils/time-ranges";
import {
  buildSilenceGapsFromSpeech,
  findSilenceBoundaryFromGaps,
  findSilenceBoundaryWithRms,
} from "../utils/audio-analysis";
import type { TimeRange } from "../types";
import type { TranscriptWordWithIndex } from "./types";

export type RefinedRange = {
  original: TimeRange;
  refined: TimeRange;
};

export function wordsToTimeRanges(words: TranscriptWordWithIndex[]): TimeRange[] {
  const ranges = words.map((word) => ({ start: word.start, end: word.end }));
  return mergeTimeRanges(ranges);
}

export async function refineRemovalRange(options: {
  inputPath: string;
  duration: number;
  range: TimeRange;
  paddingMs?: number;
}): Promise<RefinedRange> {
  const paddingSeconds = (options.paddingMs ?? EDIT_CONFIG.speechBoundaryPaddingMs) / 1000;
  const refinedStart =
    (await findSpeechBoundary({
      inputPath: options.inputPath,
      duration: options.duration,
      targetTime: options.range.start,
      direction: "before",
      searchWindowSeconds: EDIT_CONFIG.speechSearchWindowSeconds,
    })) ?? options.range.start;
  const refinedEnd =
    (await findSpeechBoundary({
      inputPath: options.inputPath,
      duration: options.duration,
      targetTime: options.range.end,
      direction: "after",
      searchWindowSeconds: EDIT_CONFIG.speechSearchWindowSeconds,
    })) ?? options.range.end;
  const paddedStart = clamp(refinedStart + paddingSeconds, 0, options.duration);
  const paddedEnd = clamp(refinedEnd - paddingSeconds, 0, options.duration);

  if (paddedEnd <= paddedStart + 0.005) {
    return { original: options.range, refined: options.range };
  }

  return {
    original: options.range,
    refined: { start: paddedStart, end: paddedEnd },
  };
}

export async function refineAllRemovalRanges(options: {
  inputPath: string;
  duration: number;
  ranges: TimeRange[];
  paddingMs?: number;
}): Promise<RefinedRange[]> {
  const refined: RefinedRange[] = [];
  for (const range of options.ranges) {
    refined.push(
      await refineRemovalRange({
        inputPath: options.inputPath,
        duration: options.duration,
        range,
        paddingMs: options.paddingMs,
      }),
    );
  }
  return refined;
}

type SpeechBoundaryDirection = "before" | "after";

async function findSpeechBoundary(options: {
  inputPath: string;
  duration: number;
  targetTime: number;
  direction: SpeechBoundaryDirection;
  searchWindowSeconds: number;
}): Promise<number | null> {
  const windowStart =
    options.direction === "before"
      ? Math.max(0, options.targetTime - options.searchWindowSeconds)
      : options.targetTime;
  const windowEnd =
    options.direction === "before"
      ? options.targetTime
      : Math.min(options.duration, options.targetTime + options.searchWindowSeconds);
  const windowDuration = windowEnd - windowStart;
  if (windowDuration <= 0.01) {
    return null;
  }
  const samples = await readAudioSamples({
    inputPath: options.inputPath,
    start: windowStart,
    duration: windowDuration,
    sampleRate: CONFIG.vadSampleRate,
  });
  if (samples.length === 0) {
    return null;
  }

  const targetOffset = options.targetTime - windowStart;
  const speechSegments = await loadSpeechSegments(samples);
  if (speechSegments.length > 0) {
    if (options.direction === "before") {
      const candidate = [...speechSegments]
        .filter((segment) => segment.end <= targetOffset + 0.001)
        .pop();
      if (candidate) {
        return windowStart + candidate.end;
      }
    } else {
      const candidate = speechSegments.find(
        (segment) => segment.start >= targetOffset - 0.001,
      );
      if (candidate) {
        return windowStart + candidate.start;
      }
    }
  }

  const gapBoundary = findBoundaryFromSilence(
    samples,
    windowDuration,
    speechSegments,
    {
      direction: options.direction,
      targetOffset,
    },
  );
  return gapBoundary === null ? null : windowStart + gapBoundary;
}

async function loadSpeechSegments(samples: Float32Array): Promise<TimeRange[]> {
  try {
    const segments = await detectSpeechSegmentsWithVad(
      samples,
      CONFIG.vadSampleRate,
      CONFIG,
    );
    return segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
    }));
  } catch {
    return [];
  }
}

function findBoundaryFromSilence(
  samples: Float32Array,
  duration: number,
  speechSegments: TimeRange[],
  options: {
    direction: SpeechBoundaryDirection;
    targetOffset: number;
  },
): number | null {
  const gaps = buildSilenceGapsFromSpeech(speechSegments, duration);
  const boundaryFromGaps = findSilenceBoundaryFromGaps(
    gaps,
    options.targetOffset,
    options.direction,
  );
  if (boundaryFromGaps !== null) {
    return boundaryFromGaps;
  }

  return findSilenceBoundaryWithRms({
    samples,
    sampleRate: CONFIG.vadSampleRate,
    direction: options.direction,
    rmsWindowMs: CONFIG.commandSilenceRmsWindowMs,
    rmsThreshold: CONFIG.commandSilenceRmsThreshold,
    minSilenceMs: CONFIG.commandSilenceMinDurationMs,
  });
}
