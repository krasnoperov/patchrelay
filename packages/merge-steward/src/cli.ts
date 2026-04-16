import { parseArgs, hasHelpFlag, validateFlags } from "./cli/args.ts";
import { helpTextFor } from "./cli/help.ts";
import { writeOutput, writeUsageError } from "./cli/output.ts";
import { defaultRunCommand } from "./cli/system.ts";
import { UsageError } from "./cli/types.ts";
import type { RunCliOptions } from "./cli/types.ts";

export type { RunCliOptions };

function rewriteParsedArgs(parsed: { positionals: string[]; flags: Map<string, string | boolean> }, positionals: string[]) {
  return {
    positionals,
    flags: parsed.flags,
  };
}

export async function runCli(argv: string[], options?: RunCliOptions): Promise<number> {
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const runCommand = options?.runCommand ?? defaultRunCommand;

  try {
    const parsed = parseArgs(argv);

    if (parsed.flags.get("version") === true || parsed.positionals[0] === "version") {
      const { version } = await import("../package.json", { with: { type: "json" } }).then((m) => m.default);
      writeOutput(stdout, `merge-steward ${version}\n`);
      return 0;
    }

    validateFlags(parsed);
    const requestedCommand = parsed.positionals[0] ?? "help";
    const command = requestedCommand === "dash" || requestedCommand === "d"
      ? "dashboard"
      : requestedCommand;

    if (hasHelpFlag(parsed) || command === "help") {
      const topic = command === "help"
        ? ((parsed.positionals[1] as "root" | "attach" | "repo" | "repos" | "service" | "queue" | undefined) ?? "root")
        : (command === "attach" || command === "repo" || command === "repos"
            ? "repo"
            : command === "service" || command === "queue"
              ? command
              : "root");
      if (!["root", "attach", "repo", "repos", "service", "queue"].includes(topic)) {
        throw new UsageError(`Unknown help topic: ${String(topic)}`);
      }
      writeOutput(stdout, `${helpTextFor(topic === "attach" ? "repo" : topic)}\n`);
      return 0;
    }

    switch (command) {
      case "serve":
        await (await import("./server.ts")).startMultiServer();
        return 0;
      case "init":
        return await (await import("./cli/commands/init.ts")).handleInit(parsed, stdout, runCommand);
      case "attach":
        return await (await import("./cli/commands/attach.ts")).handleAttach(parsed, stdout, runCommand);
      case "repos":
        return await (await import("./cli/commands/repos.ts")).handleRepos(parsed, stdout);
      case "repo": {
        const subcommand = parsed.positionals[1] ?? "list";
        if (subcommand === "attach") {
          return await (await import("./cli/commands/attach.ts")).handleAttach(rewriteParsedArgs(parsed, ["attach", ...parsed.positionals.slice(2)]), stdout, runCommand);
        }
        if (subcommand === "list") {
          return await (await import("./cli/commands/repos.ts")).handleRepos(rewriteParsedArgs(parsed, ["repos", ...parsed.positionals.slice(2)]), stdout);
        }
        if (subcommand === "show") {
          if (!parsed.positionals[2]) {
            throw new UsageError("merge-steward repo show requires <id>.", "repo");
          }
          return await (await import("./cli/commands/repos.ts")).handleRepos(rewriteParsedArgs(parsed, ["repos", ...parsed.positionals.slice(2)]), stdout);
        }
        throw new UsageError(`Unknown repo command: ${subcommand}`, "repo");
      }
      case "doctor":
        return await (await import("./cli/commands/doctor.ts")).handleDoctor(parsed, stdout);
      case "dashboard":
        return await (await import("./cli/commands/dashboard.ts")).handleDashboard(parsed);
      case "service":
        return await (await import("./cli/commands/service.ts")).handleService(parsed, stdout, runCommand);
      case "queue":
        return await (await import("./cli/commands/queue.ts")).handleQueue(parsed, stdout, options?.resolveCommand);
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
