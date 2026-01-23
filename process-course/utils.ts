import type { TranscriptSegment } from "../whispercpp-transcribe";
import { CONFIG, TRANSCRIPTION_PHRASES } from "./config";
import type {
  Chapter,
  ChapterRange,
  ChapterSelection,
  SilenceBoundaryDirection,
  SpeechBounds,
  TimeRange,
  TranscriptCommand,
  TranscriptWord,
} from "./types";
import { clamp, normalizeFilename, toKebabCase } from "../utils";

// ============================================================================
// Transcript/Command Utilities
// ============================================================================

export function normalizeSkipPhrases(rawPhrases: unknown) {
  const rawList = Array.isArray(rawPhrases) ? rawPhrases : [rawPhrases];
  const phrases = rawList
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.toLowerCase());

  return phrases.length > 0 ? phrases : TRANSCRIPTION_PHRASES;
}

export function countTranscriptWords(transcript: string) {
  if (!transcript.trim()) {
    return 0;
  }
  return transcript.trim().split(/\s+/).length;
}

export function transcriptIncludesWord(transcript: string, word: string) {
  if (!transcript.trim()) {
    return false;
  }
  const normalized = normalizeWords(transcript);
  return normalized.includes(word.toLowerCase());
}

export function scaleTranscriptSegments(
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

export function extractTranscriptCommands(
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

export function normalizeWords(text: string) {
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

// ============================================================================
// Time Range Utilities
// ============================================================================

export function mergeTimeRanges(ranges: TimeRange[]) {
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

export function buildKeepRanges(
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

export function sumRangeDuration(ranges: TimeRange[]) {
  return ranges.reduce((total, range) => total + (range.end - range.start), 0);
}

export function adjustTimeForRemovedRanges(time: number, removed: TimeRange[]) {
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

export function buildCommandWindows(
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

// ============================================================================
// Audio Analysis Utilities
// ============================================================================

export function computeRms(samples: Float32Array) {
  if (samples.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

export function computeMinWindowRms(samples: Float32Array, windowSamples: number) {
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

export function buildSilenceGapsFromSpeech(speechSegments: TimeRange[], duration: number) {
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

export function findSilenceBoundaryFromGaps(
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

export function speechFallback(duration: number, note: string): SpeechBounds {
  return { start: 0, end: duration, note };
}

export function findSilenceBoundaryWithRms(options: {
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

// ============================================================================
// Filename Utilities
// ============================================================================

export function formatChapterFilename(chapter: Chapter) {
  const title = chapter.title ?? `chapter-${chapter.index + 1}`;
  const normalized = normalizeFilename(title);
  const slug = toKebabCase(normalized);
  return `chapter-${String(chapter.index + 1).padStart(2, "0")}-${slug}`;
}

// ============================================================================
// CLI Parsing Utilities
// ============================================================================

export function parseChapterSelection(rawSelection: unknown): ChapterSelection {
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

export function resolveChapterSelection(
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

// ============================================================================
// File Utilities
// ============================================================================

import { unlink } from "node:fs/promises";
import { logInfo } from "./logging";

export async function safeUnlink(filePath: string) {
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
