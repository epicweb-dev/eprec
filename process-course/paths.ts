import path from "node:path";

export function buildIntermediatePath(
  tmpDir: string,
  outputPath: string,
  suffix: string,
) {
  const parsed = path.parse(outputPath);
  return path.join(tmpDir, `${parsed.name}-${suffix}${parsed.ext}`);
}

export function buildIntermediateAudioPath(
  tmpDir: string,
  outputPath: string,
  suffix: string,
) {
  const parsed = path.parse(outputPath);
  return path.join(tmpDir, `${parsed.name}-${suffix}.wav`);
}

export function buildTranscriptionOutputBase(tmpDir: string, outputPath: string) {
  const parsed = path.parse(outputPath);
  return path.join(tmpDir, `${parsed.name}-transcribe`);
}

export function buildJarvisOutputBase(tmpDir: string, outputPath: string) {
  const parsed = path.parse(outputPath);
  return path.join(tmpDir, `${parsed.name}-jarvis`);
}

export function buildSummaryLogPath(tmpDir: string) {
  return path.join(tmpDir, "process-summary.log");
}

export function buildJarvisWarningLogPath(outputDir: string) {
  return path.join(outputDir, "jarvis-warnings.log");
}

export function buildJarvisEditLogPath(outputDir: string) {
  return path.join(outputDir, "jarvis-edits.log");
}

export function buildChapterLogPath(tmpDir: string, outputPath: string) {
  const parsed = path.parse(outputPath);
  return path.join(tmpDir, `${parsed.name}.log`);
}
