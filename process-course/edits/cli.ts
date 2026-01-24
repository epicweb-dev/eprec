#!/usr/bin/env bun
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { editVideo, buildEditedOutputPath } from "./video-editor";
import { combineVideos } from "./combined-video-editor";

async function main() {
  const parser = yargs(hideBin(process.argv))
    .scriptName("video-edits")
    .command(
      "edit-video",
      "Edit a single video using transcript text edits",
      (command) =>
        command
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
          }),
      async (argv) => {
        const outputPath =
          typeof argv.output === "string" && argv.output.trim().length > 0
            ? argv.output
            : buildEditedOutputPath(String(argv.input));
        const result = await editVideo({
          inputPath: String(argv.input),
          transcriptJsonPath: String(argv.transcript),
          editedTextPath: String(argv.edited),
          outputPath,
          paddingMs:
            typeof argv["padding-ms"] === "number"
              ? argv["padding-ms"]
              : undefined,
        });
        if (!result.success) {
          console.error(result.error ?? "Edit failed.");
          process.exit(1);
        }
        console.log(`Edited video written to ${outputPath}`);
      },
    )
    .command(
      "combine-videos",
      "Combine two videos with speech-aligned padding",
      (command) =>
        command
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
          }),
      async (argv) => {
        const result = await combineVideos({
          video1Path: String(argv.video1),
          video1TranscriptJsonPath:
            typeof argv.transcript1 === "string" ? argv.transcript1 : undefined,
          video1EditedTextPath:
            typeof argv.edited1 === "string" ? argv.edited1 : undefined,
          video2Path: String(argv.video2),
          video2TranscriptJsonPath:
            typeof argv.transcript2 === "string" ? argv.transcript2 : undefined,
          video2EditedTextPath:
            typeof argv.edited2 === "string" ? argv.edited2 : undefined,
          outputPath: String(argv.output),
          overlapPaddingMs:
            typeof argv["padding-ms"] === "number"
              ? argv["padding-ms"]
              : undefined,
        });
        if (!result.success) {
          console.error(result.error ?? "Combine failed.");
          process.exit(1);
        }
        console.log(`Combined video written to ${result.outputPath}`);
      },
    )
    .demandCommand(1)
    .strict()
    .help();

  await parser.parseAsync();
}

main().catch((error) => {
  console.error(
    `[error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
