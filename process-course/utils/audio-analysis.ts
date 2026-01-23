import type { SilenceBoundaryDirection, SpeechBounds, TimeRange } from "../types";

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
