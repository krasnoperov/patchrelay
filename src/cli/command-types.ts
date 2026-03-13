import type { AppConfig } from "../types.ts";
import type { CliDataAccess } from "./data.ts";

export type Output = Pick<NodeJS.WriteStream, "write">;

export type InteractiveRunner = (command: string, args: string[]) => Promise<number>;

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export interface RunCliOptions {
  stdout?: Output;
  stderr?: Output;
  config?: AppConfig;
  data?: CliDataAccess;
  runInteractive?: InteractiveRunner;
  openExternal?: (url: string) => Promise<boolean>;
  connectPollIntervalMs?: number;
}
