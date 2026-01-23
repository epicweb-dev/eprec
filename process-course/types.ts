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

export type TranscriptWord = {
  word: string;
  start: number;
  end: number;
};

export type TranscriptCommand = {
  type: "bad-take" | "filename" | "nevermind" | "edit";
  value?: string;
  window: TimeRange;
};

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
