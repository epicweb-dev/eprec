export type Chapter = {
  index: number;
  start: number;
  end: number;
  title: string;
};

export type LoudnormAnalysis = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

export type SpeechBounds = {
  start: number;
  end: number;
  note?: string;
};

export type TimeRange = {
  start: number;
  end: number;
};

export type SilenceBoundaryDirection = "before" | "after";

export type JarvisWarning = {
  chapter: Chapter;
  outputPath: string;
};

export type JarvisEdit = {
  chapter: Chapter;
  outputPath: string;
};

export type ChapterRange = {
  start: number;
  end: number | null;
};

export type ChapterSelection = {
  base: 0 | 1;
  ranges: ChapterRange[];
};

// Re-export from jarvis-commands for backward compatibility
export type { TranscriptCommand, TranscriptWord } from "./jarvis-commands/types";
