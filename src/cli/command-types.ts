import type { AppConfig } from "../types.ts";
import type { CliDataAccess } from "./data.ts";
import type { CliOperatorDataAccess } from "./operator-client.ts";

export type Output = Pick<NodeJS.WriteStream, "write">;

export type InteractiveRunner = (command: string, args: string[]) => Promise<number>;

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export interface ResolvedCommand {
  command: string;
  commandArgs: string[];
}

export interface RunCliOptions {
  stdout?: Output;
  stderr?: Output;
  config?: AppConfig;
  data?: CliDataAccess | CliOperatorDataAccess;
  runInteractive?: InteractiveRunner;
  openExternal?: (url: string) => Promise<boolean>;
  connectPollIntervalMs?: number;
}
