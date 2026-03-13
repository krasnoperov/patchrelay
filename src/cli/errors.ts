import type { CliHelpTopic } from "./help.ts";

export class CliUsageError extends Error {
  constructor(
    message: string,
    readonly helpTopic: CliHelpTopic = "root",
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class UnknownCommandError extends CliUsageError {
  constructor(command: string) {
    super(`Unknown command: ${command}`);
    this.name = "UnknownCommandError";
  }
}

export class UnknownFlagsError extends CliUsageError {
  constructor(flags: string[], helpTopic: CliHelpTopic = "root") {
    super(`Unknown flag${flags.length === 1 ? "" : "s"}: ${flags.map((flag) => `--${flag}`).join(", ")}`, helpTopic);
    this.name = "UnknownFlagsError";
  }
}
