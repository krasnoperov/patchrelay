import type { AppConfig } from "../../types.ts";
import type { ParsedArgs } from "../command-types.ts";

interface WatchCommandParams {
  config: AppConfig;
  parsed: ParsedArgs;
}

function resolveBaseUrl(config: AppConfig): string {
  const bind = config.server.bind;
  let host: string;
  if (bind === "0.0.0.0") {
    host = "127.0.0.1";
  } else if (bind === "::") {
    host = "[::1]";
  } else if (bind.includes(":") && !bind.startsWith("[")) {
    host = `[${bind}]`;
  } else {
    host = bind;
  }
  return `http://${host}:${config.server.port}`;
}

export async function handleWatchCommand(params: WatchCommandParams): Promise<number> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    process.stderr.write("patchrelay dashboard requires an interactive TTY.\n");
    process.stderr.write("Use `patchrelay issue list`, `patchrelay issue show <issueKey>`, or run the dashboard from a terminal.\n");
    return 1;
  }

  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { App } = await import("../watch/App.tsx");

  const baseUrl = resolveBaseUrl(params.config);
  const bearerToken = params.config.operatorApi.bearerToken ?? undefined;
  const issueKey = typeof params.parsed.flags.get("issue") === "string"
    ? String(params.parsed.flags.get("issue"))
    : undefined;

  process.stderr.write("\u001b[?1049h\u001b[2J\u001b[H");
  try {
    const instance = render(
      createElement(App, { baseUrl, bearerToken, initialIssueKey: issueKey }),
      { stdout: process.stderr, stdin: process.stdin, patchConsole: false },
    );

    await instance.waitUntilExit();
    return 0;
  } finally {
    process.stderr.write("\u001b[?1049l");
  }
}
