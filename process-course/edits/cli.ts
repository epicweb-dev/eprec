#!/usr/bin/env bun
import type { Argv, Arguments, CommandBuilder, CommandHandler } from "yargs";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { editVideo, buildEditedOutputPath } from "./video-editor";
import { combineVideos } from "./combined-video-editor";

export type EditVideoCommandArgs = {
  input: string;
  transcript: string;
  edited: string;
  output?: string;
  "padding-ms"?: number;
};

export type CombineVideosCommandArgs = {
  video1: string;
  transcript1?: string;
  edited1?: string;
  video2: string;
  transcript2?: string;
  edited2?: string;
  output: string;
  "padding-ms"?: number;
};

export function configureEditVideoCommand(command: Argv) {
  return command
    .option("input", {
      type: "string",
      demandOption: true,
      describe: "Input video file",
    })
    .option("transcript", {
      type: "string",
      demandOption: true,
      describe: "Transcript JSON path",
    })
    .option("edited", {
      type: "string",
      demandOption: true,
      describe: "Edited transcript text path",
    })
    .option("output", {
      type: "string",
      describe: "Output video path (defaults to .edited)",
    })
    .option("padding-ms", {
      type: "number",
      describe: "Padding around speech boundaries in ms",
    });
}

export async function handleEditVideoCommand(argv: Arguments) {
  const args = argv as EditVideoCommandArgs;
  const outputPath =
    typeof args.output === "string" && args.output.trim().length > 0
      ? args.output
      : buildEditedOutputPath(String(args.input));
  const result = await editVideo({
    inputPath: String(args.input),
    transcriptJsonPath: String(args.transcript),
    editedTextPath: String(args.edited),
    outputPath,
    paddingMs:
      typeof args["padding-ms"] === "number" ? args["padding-ms"] : undefined,
  });
  if (!result.success) {
    console.error(result.error ?? "Edit failed.");
    process.exit(1);
  }
  console.log(`Edited video written to ${outputPath}`);
}

export function configureCombineVideosCommand(command: Argv) {
  return command
    .option("video1", {
      type: "string",
      demandOption: true,
      describe: "First video path",
    })
    .option("transcript1", {
      type: "string",
      describe: "Transcript JSON for first video",
    })
    .option("edited1", {
      type: "string",
      describe: "Edited transcript text for first video",
    })
    .option("video2", {
      type: "string",
      demandOption: true,
      describe: "Second video path",
    })
    .option("transcript2", {
      type: "string",
      describe: "Transcript JSON for second video",
    })
    .option("edited2", {
      type: "string",
      describe: "Edited transcript text for second video",
    })
    .option("output", {
      type: "string",
      demandOption: true,
      describe: "Output video path",
    })
    .option("padding-ms", {
      type: "number",
      describe: "Padding around speech boundaries in ms",
    });
}

export async function handleCombineVideosCommand(argv: Arguments) {
  const args = argv as CombineVideosCommandArgs;
  const result = await combineVideos({
    video1Path: String(args.video1),
    video1TranscriptJsonPath:
      typeof args.transcript1 === "string" ? args.transcript1 : undefined,
    video1EditedTextPath:
      typeof args.edited1 === "string" ? args.edited1 : undefined,
    video2Path: String(args.video2),
    video2TranscriptJsonPath:
      typeof args.transcript2 === "string" ? args.transcript2 : undefined,
    video2EditedTextPath:
      typeof args.edited2 === "string" ? args.edited2 : undefined,
    outputPath: String(args.output),
    overlapPaddingMs:
      typeof args["padding-ms"] === "number" ? args["padding-ms"] : undefined,
  });
  if (!result.success) {
    console.error(result.error ?? "Combine failed.");
    process.exit(1);
  }
  console.log(`Combined video written to ${result.outputPath}`);
}

export async function runEditsCli() {
  const parser = yargs(hideBin(process.argv))
    .scriptName("video-edits")
    .command(
      "edit-video",
      "Edit a single video using transcript text edits",
      configureEditVideoCommand as CommandBuilder,
      handleEditVideoCommand as CommandHandler,
    )
    .command(
      "combine-videos",
      "Combine two videos with speech-aligned padding",
      configureCombineVideosCommand as CommandBuilder,
      handleCombineVideosCommand as CommandHandler,
    )
    .demandCommand(1)
    .strict()
    .help();

  await parser.parseAsync();
}

if (import.meta.main) {
  runEditsCli().catch((error) => {
    console.error(
      `[error] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
