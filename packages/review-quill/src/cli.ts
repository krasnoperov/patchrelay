import { getDefaultConfigPath } from "./runtime-paths.ts";
import { startServer } from "./server.ts";

function helpText(): string {
  return `review-quill

Usage:
  review-quill serve [--config <path>]
  review-quill watch [--config <path>]
  review-quill version
  review-quill help
`;
}

function parseConfigPath(args: string[]): string | undefined {
  const index = args.findIndex((value) => value === "--config");
  if (index === -1) return undefined;
  return args[index + 1];
}

export async function runCli(args: string[]): Promise<number> {
  const command = args[0] ?? "help";

  switch (command) {
    case "serve": {
      const configPath = parseConfigPath(args.slice(1)) ?? process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
      await startServer(configPath);
      return 0;
    }
    case "watch": {
      const configPath = parseConfigPath(args.slice(1)) ?? process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
      const { startWatch } = await import("./watch/index.tsx");
      await startWatch(configPath);
      return 0;
    }
    case "version": {
      const { version } = await import("../package.json", { with: { type: "json" } }).then((module) => module.default);
      process.stdout.write(`review-quill ${version}\n`);
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${helpText()}\n`);
      return 0;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
