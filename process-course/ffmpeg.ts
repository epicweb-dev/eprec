import {
  runCommand as runCommandBase,
  runCommandBinary as runCommandBinaryBase,
  formatSeconds,
} from "../utils";
import { CONFIG, TRANSCRIPTION_SAMPLE_RATE } from "./config";
import { logCommand, logInfo } from "./logging";
import type { Chapter, LoudnormAnalysis } from "./types";

async function runCommand(command: string[], allowFailure = false) {
  return runCommandBase(command, { allowFailure, logCommand });
}

async function runCommandBinary(command: string[], allowFailure = false) {
  return runCommandBinaryBase(command, { allowFailure, logCommand });
}

export async function ensureFfmpegAvailable() {
  const ffmpeg = await runCommand(["ffmpeg", "-version"], true);
  const ffprobe = await runCommand(["ffprobe", "-version"], true);
  if (ffmpeg.exitCode !== 0 || ffprobe.exitCode !== 0) {
    throw new Error(
      "ffmpeg/ffprobe not available. Install them and ensure they are on PATH.",
    );
  }
}

export async function getChapters(inputPath: string): Promise<Chapter[]> {
  const result = await runCommand([
    "ffprobe",
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_chapters",
    "-i",
    inputPath,
  ]);

  const payload = JSON.parse(result.stdout);
  const chapters = payload.chapters ?? [];
  if (chapters.length === 0) {
    return [];
  }

  return chapters.map((chapter: any, index: number) => {
    const start = Number.parseFloat(chapter.start_time);
    const end = Number.parseFloat(chapter.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`Invalid chapter time data at index ${index}`);
    }
    return {
      index,
      start,
      end,
      title: chapter.tags?.title
        ? String(chapter.tags.title)
        : `chapter-${index + 1}`,
    };
  });
}

export async function readAudioSamples(options: {
  inputPath: string;
  start: number;
  duration: number;
  sampleRate: number;
}) {
  const result = await runCommandBinary(
    [
      "ffmpeg",
      "-hide_banner",
      "-ss",
      options.start.toFixed(3),
      "-t",
      options.duration.toFixed(3),
      "-i",
      options.inputPath,
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      String(options.sampleRate),
      "-f",
      "f32le",
      "-",
    ],
    true,
  );

  const bytes = result.stdout;
  if (bytes.byteLength === 0) {
    return new Float32Array();
  }
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return new Float32Array(buffer);
}

function buildNormalizeAudioFilter(options: {
  printFormat: "json" | "summary";
  analysis: LoudnormAnalysis | null;
}) {
  const prefilter =
    CONFIG.normalizePrefilterEnabled && CONFIG.normalizePrefilter
      ? `${CONFIG.normalizePrefilter},`
      : "";
  const loudnorm = [
    `loudnorm=I=${CONFIG.loudnessTargetI}`,
    `LRA=${CONFIG.loudnessTargetLra}`,
    `TP=${CONFIG.loudnessTargetTp}`,
  ];

  if (options.analysis) {
    loudnorm.push(
      `measured_I=${options.analysis.input_i}`,
      `measured_TP=${options.analysis.input_tp}`,
      `measured_LRA=${options.analysis.input_lra}`,
      `measured_thresh=${options.analysis.input_thresh}`,
      `offset=${options.analysis.target_offset}`,
      "linear=true",
    );
  }

  loudnorm.push(`print_format=${options.printFormat}`);

  return `${prefilter}${loudnorm.join(":")}`;
}

export async function analyzeLoudness(
  inputPath: string,
  absoluteStart: number,
  absoluteEnd: number,
): Promise<LoudnormAnalysis> {
  const clipDuration = absoluteEnd - absoluteStart;
  if (clipDuration <= 0) {
    throw new Error(
      `Invalid analysis window (${formatSeconds(absoluteStart)} -> ${formatSeconds(
        absoluteEnd,
      )})`,
    );
  }

  const filter = buildNormalizeAudioFilter({
    printFormat: "json",
    analysis: null,
  });
  const result = await runCommand(
    [
      "ffmpeg",
      "-hide_banner",
      "-ss",
      absoluteStart.toFixed(3),
      "-t",
      clipDuration.toFixed(3),
      "-i",
      inputPath,
      "-vn",
      "-sn",
      "-dn",
      "-af",
      filter,
      "-f",
      "null",
      "-",
    ],
    true,
  );

  const analysisJson = result.stderr.match(/\{[\s\S]*?\}/)?.[0];
  if (!analysisJson) {
    throw new Error("Failed to parse loudnorm analysis output.");
  }

  const payload = JSON.parse(analysisJson);
  return {
    input_i: payload.input_i,
    input_tp: payload.input_tp,
    input_lra: payload.input_lra,
    input_thresh: payload.input_thresh,
    target_offset: payload.target_offset,
  };
}

export async function renderChapter(options: {
  inputPath: string;
  outputPath: string;
  absoluteStart: number;
  absoluteEnd: number;
  analysis: LoudnormAnalysis;
}) {
  const clipDuration = options.absoluteEnd - options.absoluteStart;
  if (clipDuration <= 0) {
    throw new Error(
      `Invalid render window (${formatSeconds(options.absoluteStart)} -> ${formatSeconds(
        options.absoluteEnd,
      )})`,
    );
  }

  const loudnorm = buildNormalizeAudioFilter({
    printFormat: "summary",
    analysis: options.analysis,
  });

  const args = [
    "ffmpeg",
    "-hide_banner",
    "-y",
    "-ss",
    options.absoluteStart.toFixed(3),
    "-t",
    clipDuration.toFixed(3),
    "-i",
    options.inputPath,
    "-dn",
    "-map_chapters",
    "-1",
    "-map",
    "0:v?",
    "-map",
    "0:a?",
    "-map",
    "0:s?",
  ];

  if (CONFIG.videoReencodeForAccurateTrim) {
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18");
  } else {
    args.push("-c:v", "copy");
  }

  args.push(
    "-c:a",
    CONFIG.audioCodec,
    "-b:a",
    CONFIG.audioBitrate,
    "-af",
    loudnorm,
    "-c:s",
    "copy",
    options.outputPath,
  );

  await runCommand(args);
  logInfo(`Wrote ${options.outputPath}`);
}

export async function extractChapterSegment(options: {
  inputPath: string;
  outputPath: string;
  start: number;
  end: number;
}) {
  const clipDuration = options.end - options.start;
  if (clipDuration <= 0) {
    throw new Error(
      `Invalid segment window (${formatSeconds(options.start)} -> ${formatSeconds(
        options.end,
      )})`,
    );
  }

  const args = [
    "ffmpeg",
    "-hide_banner",
    "-y",
    "-ss",
    options.start.toFixed(3),
    "-t",
    clipDuration.toFixed(3),
    "-i",
    options.inputPath,
    "-dn",
    "-map_chapters",
    "-1",
    "-map",
    "0:v?",
    "-map",
    "0:a?",
    "-map",
    "0:s?",
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-c:s",
    "copy",
    options.outputPath,
  ];

  await runCommand(args);
}

export async function extractChapterSegmentAccurate(options: {
  inputPath: string;
  outputPath: string;
  start: number;
  end: number;
}) {
  const clipDuration = options.end - options.start;
  if (clipDuration <= 0) {
    throw new Error(
      `Invalid segment window (${formatSeconds(options.start)} -> ${formatSeconds(
        options.end,
      )})`,
    );
  }

  const args = [
    "ffmpeg",
    "-hide_banner",
    "-y",
    "-i",
    options.inputPath,
    "-ss",
    options.start.toFixed(3),
    "-t",
    clipDuration.toFixed(3),
    "-dn",
    "-map_chapters",
    "-1",
    "-map",
    "0:v?",
    "-map",
    "0:a?",
    "-map",
    "0:s?",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-c:a",
    CONFIG.audioCodec,
    "-b:a",
    CONFIG.audioBitrate,
    "-c:s",
    "copy",
    options.outputPath,
  ];

  await runCommand(args);
}

export async function extractTranscriptionAudio(options: {
  inputPath: string;
  outputPath: string;
  start: number;
  end: number;
}) {
  const clipDuration = options.end - options.start;
  if (clipDuration <= 0) {
    throw new Error(
      `Invalid transcription window (${formatSeconds(options.start)} -> ${formatSeconds(
        options.end,
      )})`,
    );
  }

  const args = [
    "ffmpeg",
    "-hide_banner",
    "-y",
    "-ss",
    options.start.toFixed(3),
    "-t",
    clipDuration.toFixed(3),
    "-i",
    options.inputPath,
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "1",
    "-ar",
    String(TRANSCRIPTION_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    options.outputPath,
  ];

  await runCommand(args);
}

export async function concatSegments(options: {
  segmentPaths: string[];
  outputPath: string;
}) {
  if (options.segmentPaths.length < 2) {
    throw new Error("Splice requires at least two segments to concat.");
  }
  const args = ["ffmpeg", "-hide_banner", "-y"];
  for (const segmentPath of options.segmentPaths) {
    args.push("-i", segmentPath);
  }
  const inputLabels = options.segmentPaths
    .map((_, index) => `[${index}:v:0][${index}:a:0]`)
    .join("");
  const concatFilter = `${inputLabels}concat=n=${options.segmentPaths.length}:v=1:a=1[v][a]`;
  const filter = `${concatFilter};[a]aresample=async=1:first_pts=0[aout]`;
  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[aout]",
  );
  if (CONFIG.commandSpliceReencode) {
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18");
  } else {
    args.push("-c:v", "copy");
  }
  args.push("-c:a", CONFIG.audioCodec, "-b:a", CONFIG.audioBitrate);
  args.push(options.outputPath);
  await runCommand(args);
}
