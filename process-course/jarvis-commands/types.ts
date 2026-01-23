import type { TimeRange } from "../types";

export type CommandType = "bad-take" | "filename" | "nevermind" | "edit";

export interface TranscriptCommand {
  type: CommandType;
  value?: string;
  window: TimeRange;
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface CommandExtractionOptions {
  wakeWord: string;
  closeWord: string;
}

export interface CommandWindowOptions {
  offset: number;
  min: number;
  max: number;
  paddingSeconds: number;
}

export interface CommandAnalysisResult {
  commands: TranscriptCommand[];
  filenameOverride: string | null;
  hasBadTake: boolean;
  hasEdit: boolean;
  shouldSkip: boolean;
  skipReason?: string;
}
