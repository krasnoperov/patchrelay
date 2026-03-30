import { parseArgs, hasHelpFlag, validateFlags } from "./cli/args.ts";
import { helpTextFor } from "./cli/help.ts";
import { writeOutput, writeUsageError } from "./cli/output.ts";
import { defaultRunCommand } from "./cli/system.ts";
import { UsageError } from "./cli/types.ts";
import type { RunCliOptions } from "./cli/types.ts";

import { handleInit } from "./cli/commands/init.ts";
import { handleAttach } from "./cli/commands/attach.ts";
import { handleRepos } from "./cli/commands/repos.ts";
import { handleDoctor } from "./cli/commands/doctor.ts";
import { handleService } from "./cli/commands/service.ts";
import { handleQueue } from "./cli/commands/queue.ts";

export type { RunCliOptions };

export async function runCli(argv: string[], options?: RunCliOptions): Promise<number> {
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const runCommand = options?.runCommand ?? defaultRunCommand;

  try {
    const parsed = parseArgs(argv);
    validateFlags(parsed);
    const command = parsed.positionals[0] ?? "help";

    if (hasHelpFlag(parsed) || command === "help") {
      const topic = command === "help"
        ? ((parsed.positionals[1] as "root" | "attach" | "repos" | "service" | "queue" | undefined) ?? "root")
        : (command === "attach" || command === "repos"
            ? "repos"
            : command === "service" || command === "queue"
              ? command
              : "root");
      if (!["root", "attach", "repos", "service", "queue"].includes(topic)) {
        throw new UsageError(`Unknown help topic: ${String(topic)}`);
      }
      writeOutput(stdout, `${helpTextFor(topic === "attach" ? "repos" : topic)}\n`);
      return 0;
    }

    switch (command) {
      case "serve":
        await (await import("./server.ts")).startMultiServer();
        return 0;
      case "init":
        return await handleInit(parsed, stdout, runCommand);
      case "attach":
        return await handleAttach(parsed, stdout, runCommand);
      case "repos":
        return await handleRepos(parsed, stdout);
      case "doctor":
        return await handleDoctor(parsed, stdout);
      case "service":
        return await handleService(parsed, stdout, runCommand);
      case "queue":
        return await handleQueue(parsed, stdout);
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      writeUsageError(stderr, error);
      return 1;
    }
    writeOutput(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
