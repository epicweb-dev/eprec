import type { TranscriptSegment } from "../../whispercpp-transcribe";
import { CONFIG } from "../config";
import type { TimeRange } from "../types";
import { normalizeWords } from "../utils/transcript";
import type {
  TranscriptCommand,
  TranscriptWord,
  CommandExtractionOptions,
} from "./types";

/**
 * Scale transcript segments to match actual duration if needed.
 */
export function scaleTranscriptSegments(
  segments: TranscriptSegment[],
  duration: number,
): TranscriptSegment[] {
  if (segments.length === 0) {
    return segments;
  }
  const candidates = segments.filter((segment) =>
    /[a-z0-9]/i.test(segment.text),
  );
  const maxEnd = Math.max(
    ...(candidates.length > 0 ? candidates : segments).map(
      (segment) => segment.end,
    ),
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

/**
 * Extract jarvis commands from transcript segments.
 */
export function extractTranscriptCommands(
  segments: TranscriptSegment[],
  options: CommandExtractionOptions,
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

/**
 * Parse command words into a typed command.
 */
function parseCommand(
  words: string[],
  window: TimeRange,
): TranscriptCommand | null {
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
  if (words[0] === "note") {
    const value = words.slice(1).join(" ").trim();
    if (!value) {
      return null;
    }
    return { type: "note", value, window };
  }
  if (words[0] === "split") {
    return { type: "split", window };
  }
  if (words.length >= 2 && words[0] === "new" && words[1] === "chapter") {
    return { type: "split", window };
  }
  return null;
}

/**
 * Check if a word can start a command.
 */
function isCommandStarter(word: string): boolean {
  return (
    word === "bad" ||
    word === "filename" ||
    word === "file" ||
    word === "edit" ||
    word === "note" ||
    word === "split" ||
    word === "new"
  );
}

/**
 * Build word-level timing from transcript segments.
 */
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
