export const CONFIG = {
  preSpeechPaddingSeconds: 0.25,
  postSpeechPaddingSeconds: 0.35,
  rawTrimPaddingSeconds: 0.1,
  vadSampleRate: 16000,
  vadWindowSamples: 512,
  vadSpeechThreshold: 0.65,
  vadNegThreshold: 0.55,
  vadMinSpeechDurationMs: 250,
  vadMinSilenceDurationMs: 120,
  vadSpeechPadMs: 10,
  vadModelUrl:
    "https://huggingface.co/freddyaboulton/silero-vad/resolve/main/silero_vad.onnx",
  normalizePrefilterEnabled: true,
  normalizePrefilter: "highpass=f=80,afftdn",
  loudnessTargetI: -16,
  loudnessTargetLra: 11,
  loudnessTargetTp: -1.5,
  videoReencodeForAccurateTrim: false,
  audioCodec: "aac",
  audioBitrate: "192k",
  commandTrimPaddingSeconds: 0.25,
  commandSpliceReencode: true,
  commandSilenceSearchSeconds: 0.6,
  commandSilenceMinDurationMs: 120,
  commandSilenceRmsWindowMs: 6,
  commandSilenceRmsThreshold: 0.035,
  commandSilenceMaxBackwardSeconds: 0.2,
  commandTailMaxSeconds: 12,
  // Transcript analysis
  minTranscriptWords: 10,
  // Trim window validation
  minTrimWindowSeconds: 0.05,
} as const;

export const DEFAULT_MIN_CHAPTER_SECONDS = 15;
export const TRANSCRIPTION_PHRASES = ["jarvis bad take", "bad take jarvis"];
export const COMMAND_WAKE_WORD = "jarvis";
export const COMMAND_CLOSE_WORD = "thanks";
export const TRANSCRIPTION_SAMPLE_RATE = 16000;
