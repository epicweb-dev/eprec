import type { SilenceBoundaryDirection, SpeechBounds, TimeRange } from "../types";
import { readAudioSamples } from "../ffmpeg";
import { CONFIG } from "../config";

/**
 * Compute the RMS (root mean square) of audio samples.
 */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

/**
 * Compute the minimum RMS value across all windows of a given size.
 */
export function computeMinWindowRms(
  samples: Float32Array,
  windowSamples: number,
): number {
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

export function findSpeechStartWithRms(options: {
  samples: Float32Array;
  sampleRate: number;
  rmsWindowMs: number;
  rmsThreshold: number;
}): number | null {
  const windowSamples = Math.max(
    1,
    Math.round((options.sampleRate * options.rmsWindowMs) / 1000),
  );
  const totalWindows = Math.floor(options.samples.length / windowSamples);
  if (totalWindows === 0) {
    return null;
  }
  for (let index = 0; index < totalWindows; index += 1) {
    const offset = index * windowSamples;
    let sumSquares = 0;
    for (let i = 0; i < windowSamples; i += 1) {
      const sample = options.samples[offset + i] ?? 0;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / windowSamples);
    if (rms >= options.rmsThreshold) {
      return (index * windowSamples) / options.sampleRate;
    }
  }
  return null;
}

export function findSpeechEndWithRms(options: {
  samples: Float32Array;
  sampleRate: number;
  rmsWindowMs: number;
  rmsThreshold: number;
}): number | null {
  const windowSamples = Math.max(
    1,
    Math.round((options.sampleRate * options.rmsWindowMs) / 1000),
  );
  const totalWindows = Math.floor(options.samples.length / windowSamples);
  if (totalWindows === 0) {
    return null;
  }
  for (let index = totalWindows - 1; index >= 0; index -= 1) {
    const offset = index * windowSamples;
    let sumSquares = 0;
    for (let i = 0; i < windowSamples; i += 1) {
      const sample = options.samples[offset + i] ?? 0;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / windowSamples);
    if (rms >= options.rmsThreshold) {
      return ((index + 1) * windowSamples) / options.sampleRate;
    }
  }
  return null;
}

/**
 * Build silence gaps from speech segments and total duration.
 */
export function buildSilenceGapsFromSpeech(
  speechSegments: TimeRange[],
  duration: number,
): TimeRange[] {
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

/**
 * Find a silence boundary from pre-computed gaps.
 */
export function findSilenceBoundaryFromGaps(
  gaps: TimeRange[],
  targetOffset: number,
  direction: SilenceBoundaryDirection,
): number | null {
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

/**
 * Create a fallback speech bounds covering the full duration.
 */
export function speechFallback(duration: number, note: string): SpeechBounds {
  return { start: 0, end: duration, note };
}

/**
 * Find a silence boundary using RMS analysis.
 */
export function findSilenceBoundaryWithRms(options: {
  samples: Float32Array;
  sampleRate: number;
  direction: SilenceBoundaryDirection;
  rmsWindowMs: number;
  rmsThreshold: number;
  minSilenceMs: number;
}): number | null {
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

export function findSilenceBoundaryProgressive(options: {
  samples: Float32Array;
  sampleRate: number;
  direction: SilenceBoundaryDirection;
  startWindowSeconds: number;
  stepSeconds: number;
  maxWindowSeconds: number;
  rmsWindowMs: number;
  rmsThreshold: number;
  minSilenceMs: number;
}): number | null {
  if (options.samples.length === 0 || options.sampleRate <= 0) {
    return null;
  }
  const totalSeconds = options.samples.length / options.sampleRate;
  const maxWindowSeconds = Math.min(
    options.maxWindowSeconds,
    totalSeconds,
  );
  if (maxWindowSeconds <= 0.01) {
    return null;
  }
  const startWindowSeconds = Math.min(
    Math.max(options.startWindowSeconds, 0.01),
    maxWindowSeconds,
  );
  const stepSeconds = Math.max(options.stepSeconds, 0.01);
  const totalSamples = options.samples.length;

  for (
    let windowSeconds = startWindowSeconds;
    windowSeconds <= maxWindowSeconds + 1e-6;
    windowSeconds = Math.min(maxWindowSeconds, windowSeconds + stepSeconds)
  ) {
    const windowSamples = Math.max(
      1,
      Math.round(windowSeconds * options.sampleRate),
    );
    if (options.direction === "before") {
      const startIndex = Math.max(0, totalSamples - windowSamples);
      const slice = options.samples.subarray(startIndex, totalSamples);
      const boundary = findSilenceBoundaryWithRms({
        samples: slice,
        sampleRate: options.sampleRate,
        direction: options.direction,
        rmsWindowMs: options.rmsWindowMs,
        rmsThreshold: options.rmsThreshold,
        minSilenceMs: options.minSilenceMs,
      });
      if (boundary !== null) {
        const windowStartOffset = totalSeconds - windowSeconds;
        return windowStartOffset + boundary;
      }
    } else {
      const slice = options.samples.subarray(0, windowSamples);
      const boundary = findSilenceBoundaryWithRms({
        samples: slice,
        sampleRate: options.sampleRate,
        direction: options.direction,
        rmsWindowMs: options.rmsWindowMs,
        rmsThreshold: options.rmsThreshold,
        minSilenceMs: options.minSilenceMs,
      });
      if (boundary !== null) {
        return boundary;
      }
    }

    if (windowSeconds >= maxWindowSeconds) {
      break;
    }
  }

  return null;
}

export function findLowestAmplitudeOffset(options: {
  samples: Float32Array;
  sampleRate: number;
  rmsWindowMs: number;
}): { offsetSeconds: number; rms: number } | null {
  const windowSamples = Math.max(
    1,
    Math.round((options.sampleRate * options.rmsWindowMs) / 1000),
  );
  if (options.samples.length === 0 || windowSamples <= 0) {
    return null;
  }
  if (options.samples.length <= windowSamples) {
    return {
      offsetSeconds: (options.samples.length / 2) / options.sampleRate,
      rms: computeRms(options.samples),
    };
  }
  let minRms = Number.POSITIVE_INFINITY;
  let minOffset = 0;
  for (
    let offset = 0;
    offset + windowSamples <= options.samples.length;
    offset += windowSamples
  ) {
    let sumSquares = 0;
    for (let index = 0; index < windowSamples; index += 1) {
      const sample = options.samples[offset + index] ?? 0;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / windowSamples);
    if (rms < minRms) {
      minRms = rms;
      minOffset = offset;
    }
  }
  if (!Number.isFinite(minRms)) {
    return null;
  }
  const offsetSeconds =
    (minOffset + windowSamples / 2) / options.sampleRate;
  return { offsetSeconds, rms: minRms };
}

export function findLowestAmplitudeBoundaryProgressive(options: {
  samples: Float32Array;
  sampleRate: number;
  direction: SilenceBoundaryDirection;
  startWindowSeconds: number;
  stepSeconds: number;
  maxWindowSeconds: number;
  rmsWindowMs: number;
  rmsThreshold: number;
}): number | null {
  if (options.samples.length === 0 || options.sampleRate <= 0) {
    return null;
  }
  const totalSeconds = options.samples.length / options.sampleRate;
  const maxWindowSeconds = Math.min(options.maxWindowSeconds, totalSeconds);
  if (maxWindowSeconds <= 0.01) {
    return null;
  }
  const startWindowSeconds = Math.min(
    Math.max(options.startWindowSeconds, 0.01),
    maxWindowSeconds,
  );
  const stepSeconds = Math.max(options.stepSeconds, 0.01);
  const totalSamples = options.samples.length;

  for (
    let windowSeconds = startWindowSeconds;
    windowSeconds <= maxWindowSeconds + 1e-6;
    windowSeconds = Math.min(maxWindowSeconds, windowSeconds + stepSeconds)
  ) {
    const windowSamples = Math.max(
      1,
      Math.round(windowSeconds * options.sampleRate),
    );
    let slice: Float32Array;
    let offsetBaseSeconds = 0;
    if (options.direction === "before") {
      const startIndex = Math.max(0, totalSamples - windowSamples);
      slice = options.samples.subarray(startIndex, totalSamples);
      offsetBaseSeconds = (totalSamples - windowSamples) / options.sampleRate;
    } else {
      slice = options.samples.subarray(0, windowSamples);
    }
    const lowest = findLowestAmplitudeOffset({
      samples: slice,
      sampleRate: options.sampleRate,
      rmsWindowMs: options.rmsWindowMs,
    });
    if (lowest && lowest.rms < options.rmsThreshold) {
      return offsetBaseSeconds + lowest.offsetSeconds;
    }
    if (windowSeconds >= maxWindowSeconds) {
      break;
    }
  }

  return null;
}

/**
 * Find speech end using RMS analysis with audio sample loading fallback.
 */
export async function findSpeechEndWithRmsFallback(options: {
  inputPath: string;
  start: number;
  duration: number;
}): Promise<number | null> {
  if (options.duration <= 0.05) {
    return null;
  }
  const samples = await readAudioSamples({
    inputPath: options.inputPath,
    start: options.start,
    duration: options.duration,
    sampleRate: CONFIG.vadSampleRate,
  });
  if (samples.length === 0) {
    return null;
  }
  return findSpeechEndWithRms({
    samples,
    sampleRate: CONFIG.vadSampleRate,
    rmsWindowMs: CONFIG.commandSilenceRmsWindowMs,
    rmsThreshold: CONFIG.commandSilenceRmsThreshold,
  });
}

/**
 * Find speech start using RMS analysis with audio sample loading fallback.
 */
export async function findSpeechStartWithRmsFallback(options: {
  inputPath: string;
  start: number;
  duration: number;
}): Promise<number | null> {
  if (options.duration <= 0.05) {
    return null;
  }
  const samples = await readAudioSamples({
    inputPath: options.inputPath,
    start: options.start,
    duration: options.duration,
    sampleRate: CONFIG.vadSampleRate,
  });
  if (samples.length === 0) {
    return null;
  }
  return findSpeechStartWithRms({
    samples,
    sampleRate: CONFIG.vadSampleRate,
    rmsWindowMs: CONFIG.commandSilenceRmsWindowMs,
    rmsThreshold: CONFIG.commandSilenceRmsThreshold,
  });
}
