import pino from "pino";
import {
  defaultRunCommand,
  type CommandRunner,
} from "./cli-system.ts";
import { getDefaultConfigPath } from "./runtime-paths.ts";
import { helpTextFor, writeUsageError } from "./cli/help.ts";
import type { Output } from "./cli/shared.ts";
import { writeOutput } from "./cli/shared.ts";
import {
  hasHelpFlag,
  parseArgs,
  parseConfigPath,
  rewriteParsedArgs,
  type HelpTopic,
  type ParsedArgs,
  UsageError,
  validateFlags,
} from "./cli/args.ts";
import { handleAttempts } from "./cli/attempts.ts";
import { handleDiff } from "./cli/diff.ts";
import { handleDoctor } from "./cli/doctor.ts";
import { handleAttach, handleInit, handleRepos } from "./cli/repo.ts";
import { handleService } from "./cli/service.ts";
import { handleTranscript } from "./cli/transcript.ts";
import { handleTranscriptSource } from "./cli/transcript-source.ts";
import { handleStatus } from "./cli/status.ts";
import type { ResolveCommandRunner } from "./cli/resolve.ts";
import type { CodexThreadSummary } from "./types.ts";

interface RunCliOptions {
  stdout?: Output;
  stderr?: Output;
  runCommand?: CommandRunner;
  resolveCommand?: ResolveCommandRunner;
  readCodexThread?: (threadId: string) => Promise<CodexThreadSummary>;
}

function writeHelp(stream: Output, topic: HelpTopic): void {
  writeOutput(stream, `${helpTextFor(topic)}\n`);
}

function helpTopicForCommand(command: string | undefined, topicArg: string | undefined): HelpTopic {
  if (command === "help") {
    switch (topicArg) {
      case "repo":
      case "attach":
      case "repos":
        return "repo";
      case "service":
        return "service";
      case "root":
      case undefined:
      case "dashboard":
      case "watch":
        return "root";
      default:
        throw new UsageError(`Unknown help topic: ${topicArg}`);
    }
  }

  switch (command) {
    case "attach":
    case "repo":
    case "repos":
      return "repo";
    case "service":
      return "service";
    default:
      return "root";
  }
}

function helpTopicFromParsedArgs(parsed: ParsedArgs): HelpTopic {
  return helpTopicForCommand(parsed.positionals[0], parsed.positionals[1]);
}

export async function runCli(args: string[], options?: RunCliOptions): Promise<number> {
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const runCommand = options?.runCommand ?? defaultRunCommand;

  try {
    const parsed = parseArgs(args);

    if (parsed.flags.get("version") === true || parsed.positionals[0] === "version") {
      const { version } = await import("../package.json", { with: { type: "json" } }).then((module) => module.default);
      writeOutput(stdout, `review-quill ${version}\n`);
      return 0;
    }

    validateFlags(parsed);
    const command = parsed.positionals[0] ?? "help";

    if (hasHelpFlag(parsed) || command === "help") {
      writeHelp(stdout, helpTopicFromParsedArgs(parsed));
      return 0;
    }

    switch (command) {
      case "serve": {
        const configPath = parseConfigPath(args.slice(1)) ?? process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
        const { startServer } = await import("./server.ts");
        await startServer(configPath);
        return 0;
      }
      case "watch":
      case "dashboard": {
        const configPath = parseConfigPath(args.slice(1)) ?? process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
        const { startWatch } = await import("./watch/index.tsx");
        await startWatch(configPath);
        return 0;
      }
      case "init":
        return await handleInit(parsed, stdout, runCommand);
      case "attach":
        return await handleAttach(parsed, stdout, runCommand);
      case "repos":
        return await handleRepos(parsed, stdout);
      case "repo": {
        const subcommand = parsed.positionals[1] ?? "list";
        if (subcommand === "attach") {
          return await handleAttach(rewriteParsedArgs(parsed, ["attach", ...parsed.positionals.slice(2)]), stdout, runCommand);
        }
        if (subcommand === "list") {
          return await handleRepos(rewriteParsedArgs(parsed, ["repos", ...parsed.positionals.slice(2)]), stdout);
        }
        if (subcommand === "show") {
          if (!parsed.positionals[2]) {
            throw new UsageError("review-quill repo show requires <id>.", "repo");
          }
          return await handleRepos(rewriteParsedArgs(parsed, ["repos", ...parsed.positionals.slice(2)]), stdout);
        }
        throw new UsageError(`Unknown repo command: ${subcommand}`, "repo");
      }
      case "doctor":
        return await handleDoctor(parsed, stdout, runCommand);
      case "attempts":
        return await handleAttempts(parsed, stdout, options?.resolveCommand);
      case "transcript":
        return await handleTranscript(parsed, stdout, options?.readCodexThread, options?.resolveCommand);
      case "transcript-source":
        return await handleTranscriptSource(parsed, stdout, options?.resolveCommand);
      case "status":
        return await handleStatus(parseConfigPath(args.slice(1)), parsed, stdout);
      case "diff":
        return await handleDiff(parsed, stdout);
      case "service":
        return await handleService(parsed, stdout, runCommand);
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
