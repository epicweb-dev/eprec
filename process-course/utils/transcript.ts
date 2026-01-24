import type { TranscriptSegment } from "../../whispercpp-transcribe";
import type { TimeRange } from "../types";
import { TRANSCRIPTION_PHRASES } from "../config";

/**
 * Normalize skip phrases from CLI input.
 */
export function normalizeSkipPhrases(rawPhrases: unknown): string[] {
  const rawList = Array.isArray(rawPhrases) ? rawPhrases : [rawPhrases];
  const phrases = rawList
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  const uniquePhrases = [...new Set(phrases)];

  return uniquePhrases.length > 0 ? uniquePhrases : TRANSCRIPTION_PHRASES;
}

/**
 * Count words in a transcript string.
 */
export function countTranscriptWords(transcript: string): number {
  if (!transcript.trim()) {
    return 0;
  }
  return transcript.trim().split(/\s+/).length;
}

/**
 * Check if a transcript includes a specific word.
 */
export function transcriptIncludesWord(
  transcript: string,
  word: string,
): boolean {
  if (!transcript.trim()) {
    return false;
  }
  const normalized = normalizeWords(transcript);
  return normalized.includes(word.toLowerCase());
}

/**
 * Normalize text into an array of lowercase words, with common corrections.
 */
export function normalizeWords(text: string): string[] {
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

export function findWordTimings(
  segments: TranscriptSegment[],
  word: string,
): TimeRange[] {
  const target = word.trim().toLowerCase();
  if (!target) {
    return [];
  }
  const words = buildTranscriptWords(segments);
  return words
    .filter((entry) => entry.word === target)
    .map((entry) => ({ start: entry.start, end: entry.end }));
}

type TranscriptWordTiming = {
  word: string;
  start: number;
  end: number;
};

function buildTranscriptWords(
  segments: TranscriptSegment[],
): TranscriptWordTiming[] {
  const words: TranscriptWordTiming[] = [];
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
