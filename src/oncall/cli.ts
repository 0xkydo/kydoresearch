import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OncallSupervisor,
  parseSupervisorArgs,
  supervisorHelp,
} from "./supervisor.ts";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const entryDirectory = path.dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = path.resolve(
    entryDirectory,
    path.basename(entryDirectory) === "bin" ? ".." : "../..",
  );
  let parsed;
  try {
    parsed = parseSupervisorArgs(argv, process.cwd(), runtimeRoot);
  } catch (error) {
    process.stderr.write(
      `pi-kydo: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stderr.write("Run pi-kydo --help for usage.\n");
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    process.stdout.write(`${supervisorHelp()}\n`);
    return;
  }
  const supervisor = new OncallSupervisor(parsed.options);
  process.exitCode = await supervisor.run();
}

void main();
