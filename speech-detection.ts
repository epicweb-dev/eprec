import path from "node:path";
import { mkdir } from "node:fs/promises";
import * as ort from "onnxruntime-node";
import { readAudioSamples } from "./process-course/ffmpeg";
import { CONFIG } from "./process-course/config";
import { formatSeconds } from "./utils";
import { speechFallback } from "./process-course/utils";
import type { SpeechBounds } from "./process-course/types";

export type VadConfig = {
  vadWindowSamples: number;
  vadSpeechThreshold: number;
  vadNegThreshold: number;
  vadMinSpeechDurationMs: number;
  vadMinSilenceDurationMs: number;
  vadSpeechPadMs: number;
  vadModelUrl: string;
};

type VadSegment = { start: number; end: number };

let vadSessionPromise: Promise<ort.InferenceSession> | null = null;

export async function detectSpeechSegmentsWithVad(
  samples: Float32Array,
  sampleRate: number,
  config: VadConfig,
): Promise<VadSegment[]> {
  const vadSession = await getVadSession(config);
  const probabilities = await getVadProbabilities(
    samples,
    sampleRate,
    config,
    vadSession,
  );
  return probabilitiesToSegments(samples.length, probabilities, sampleRate, config);
}

async function getVadSession(config: VadConfig) {
  if (!vadSessionPromise) {
    vadSessionPromise = (async () => {
      const modelPath = await ensureVadModel(config);
      return ort.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
      });
    })();
  }
  return vadSessionPromise;
}

async function ensureVadModel(config: VadConfig) {
  const cacheDir = path.join(process.cwd(), ".cache");
  const modelPath = path.join(cacheDir, "silero-vad.onnx");
  const file = Bun.file(modelPath);
  if (await file.exists()) {
    return modelPath;
  }

  await mkdir(cacheDir, { recursive: true });
  const response = await fetch(config.vadModelUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download VAD model (${response.status} ${response.statusText}).`,
    );
  }
  const buffer = await response.arrayBuffer();
  await Bun.write(modelPath, new Uint8Array(buffer));
  return modelPath;
}

async function getVadProbabilities(
  samples: Float32Array,
  sampleRate: number,
  config: VadConfig,
  session: ort.InferenceSession,
) {
  const windowSamples = config.vadWindowSamples;
  const srTensor = new ort.Tensor(
    "int64",
    new BigInt64Array([BigInt(sampleRate)]),
    [],
  );
  const probabilities: number[] = [];
  let stateH = new Float32Array(2 * 1 * 64);
  let stateC = new Float32Array(2 * 1 * 64);

  for (let offset = 0; offset < samples.length; offset += windowSamples) {
    const chunk = samples.subarray(offset, offset + windowSamples);
    const paddedChunk = new Float32Array(windowSamples);
    paddedChunk.set(chunk);

    const inputTensor = new ort.Tensor(
      "float32",
      paddedChunk,
      [1, windowSamples],
    );
    const hTensor = new ort.Tensor("float32", stateH, [2, 1, 64]);
    const cTensor = new ort.Tensor("float32", stateC, [2, 1, 64]);

    const outputs = await session.run({
      input: inputTensor,
      sr: srTensor,
      h: hTensor,
      c: cTensor,
    });

    const { probTensor, hTensor: nextH, cTensor: nextC } = pickVadOutputs(
      outputs,
      session.outputNames,
    );
    probabilities.push((probTensor.data as Float32Array)[0] ?? 0);
    stateH = new Float32Array(nextH.data as Float32Array);
    stateC = new Float32Array(nextC.data as Float32Array);
  }

  return probabilities;
}

function pickVadOutputs(
  outputs: Record<string, ort.Tensor>,
  outputNames: readonly string[],
) {
  let probTensor: ort.Tensor | null = null;
  let hTensor: ort.Tensor | null = null;
  let cTensor: ort.Tensor | null = null;

  for (const name of outputNames) {
    const tensor = outputs[name];
    if (!tensor) {
      continue;
    }
    if (name === "output") {
      probTensor = tensor;
    } else if (name === "hn") {
      hTensor = tensor;
    } else if (name === "cn") {
      cTensor = tensor;
    }
  }

  if (!probTensor || !hTensor || !cTensor) {
    throw new Error("Unexpected VAD outputs; unable to read speech probabilities.");
  }

  return { probTensor, hTensor, cTensor };
}

function probabilitiesToSegments(
  totalSamples: number,
  probabilities: number[],
  sampleRate: number,
  config: VadConfig,
): VadSegment[] {
  const windowSamples = config.vadWindowSamples;
  const threshold = config.vadSpeechThreshold;
  const negThreshold = config.vadNegThreshold;
  const minSpeechSamples = (sampleRate * config.vadMinSpeechDurationMs) / 1000;
  const minSilenceSamples = (sampleRate * config.vadMinSilenceDurationMs) / 1000;
  const speechPadSamples = (sampleRate * config.vadSpeechPadMs) / 1000;

  let triggered = false;
  let tempEnd = 0;
  let currentSpeechStart = 0;
  const speeches: VadSegment[] = [];

  for (let index = 0; index < probabilities.length; index += 1) {
    const prob = probabilities[index] ?? 0;
    const currentSample = index * windowSamples;

    if (prob >= threshold && tempEnd) {
      tempEnd = 0;
    }

    if (prob >= threshold && !triggered) {
      triggered = true;
      currentSpeechStart = currentSample;
      continue;
    }

    if (prob < negThreshold && triggered) {
      if (!tempEnd) {
        tempEnd = currentSample;
      }
      if (currentSample - tempEnd < minSilenceSamples) {
        continue;
      }
      const speechEnd = tempEnd;
      if (speechEnd - currentSpeechStart >= minSpeechSamples) {
        speeches.push({ start: currentSpeechStart, end: speechEnd });
      }
      triggered = false;
      tempEnd = 0;
      currentSpeechStart = 0;
    }
  }

  if (triggered) {
    const speechEnd = totalSamples;
    if (speechEnd - currentSpeechStart >= minSpeechSamples) {
      speeches.push({ start: currentSpeechStart, end: speechEnd });
    }
  }

  if (speeches.length === 0) {
    return [];
  }

  for (let index = 0; index < speeches.length; index += 1) {
    const speech = speeches[index];
    if (!speech) {
      continue;
    }
    const nextSpeech = speeches[index + 1];
    if (index === 0) {
      speech.start = Math.max(0, speech.start - speechPadSamples);
    }
    if (nextSpeech) {
      const silence = nextSpeech.start - speech.end;
      if (silence < speechPadSamples * 2) {
        const adjustment = silence / 2;
        speech.end += adjustment;
        nextSpeech.start = Math.max(0, nextSpeech.start - adjustment);
      } else {
        speech.end = Math.min(totalSamples, speech.end + speechPadSamples);
        nextSpeech.start = Math.max(0, nextSpeech.start - speechPadSamples);
      }
    } else {
      speech.end = Math.min(totalSamples, speech.end + speechPadSamples);
    }
  }

  return speeches.map((speech) => ({
    start: speech.start / sampleRate,
    end: speech.end / sampleRate,
  }));
}

export async function detectSpeechBounds(
  inputPath: string,
  chapterStart: number,
  chapterEnd: number,
  duration: number,
): Promise<SpeechBounds> {
  const clipDuration = chapterEnd - chapterStart;
  if (clipDuration <= 0) {
    return speechFallback(duration, "Invalid chapter boundaries; using full chapter.");
  }

  const samples = await readAudioSamples({
    inputPath,
    start: chapterStart,
    duration: clipDuration,
    sampleRate: CONFIG.vadSampleRate,
  });
  const fallbackNote = `Speech detection failed near ${formatSeconds(chapterStart)}; using full chapter.`;
  if (samples.length === 0) {
    return speechFallback(duration, fallbackNote);
  }

  const vadSegments = await detectSpeechSegmentsWithVad(
    samples,
    CONFIG.vadSampleRate,
    CONFIG,
  );
  if (vadSegments.length === 0) {
    return speechFallback(duration, fallbackNote);
  }
  const firstSegment = vadSegments[0];
  const lastSegment = vadSegments[vadSegments.length - 1];
  if (!firstSegment || !lastSegment) {
    return speechFallback(duration, fallbackNote);
  }
  const speechStart = firstSegment.start;
  const speechEnd = lastSegment.end;

  if (speechEnd <= speechStart + 0.1) {
    return speechFallback(duration, fallbackNote);
  }

  return { start: speechStart, end: speechEnd };
}

export async function checkSegmentHasSpeech(
  inputPath: string,
  duration: number,
): Promise<boolean> {
  if (duration <= 0) {
    return false;
  }

  const samples = await readAudioSamples({
    inputPath,
    start: 0,
    duration,
    sampleRate: CONFIG.vadSampleRate,
  });
  if (samples.length === 0) {
    return false;
  }

  const vadSegments = await detectSpeechSegmentsWithVad(
    samples,
    CONFIG.vadSampleRate,
    CONFIG,
  );
  return vadSegments.length > 0;
}
