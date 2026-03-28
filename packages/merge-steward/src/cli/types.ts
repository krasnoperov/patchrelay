export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export type HelpTopic = "root" | "repos" | "service" | "queue";

export interface Output {
  write(chunk: string): boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface RunCliOptions {
  stdout?: Output;
  stderr?: Output;
  runCommand?: CommandRunner;
}

export class UsageError extends Error {
  constructor(message: string, readonly helpTopic: HelpTopic = "root") {
    super(message);
    this.name = "UsageError";
  }
}
