#!/usr/bin/env bun
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { PROCESS_USAGE, registerProcessCommand } from "./process-course/cli";
import { runProcessCommand } from "./process-course-video";

export async function runCli(rawArgs = hideBin(process.argv)) {
  const parser = registerProcessCommand(yargs(rawArgs), runProcessCommand)
    .scriptName("eprec")
    .usage(PROCESS_USAGE)
    .demandCommand(1, "A command is required.")
    .strict()
    .help();

  await parser.parseAsync();
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(`[error] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
