import { createElement } from "react";
import { render } from "ink";
import { loadConfig } from "../config.ts";
import { App } from "./App.tsx";

function resolveBaseUrl(configPath: string): string {
  const config = loadConfig(configPath);
  const bind = config.server.bind === "0.0.0.0" ? "127.0.0.1"
    : config.server.bind === "::" ? "[::1]"
    : config.server.bind.includes(":") && !config.server.bind.startsWith("[") ? `[${config.server.bind}]`
    : config.server.bind;
  return `http://${bind}:${config.server.port}`;
}

export async function startWatch(configPath: string): Promise<void> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("review-quill watch requires an interactive TTY");
  }

  const baseUrl = resolveBaseUrl(configPath);
  process.stderr.write("\u001b[?1049h\u001b[2J\u001b[H");
  try {
    const instance = render(
      createElement(App, { baseUrl }),
      { stdout: process.stderr, stdin: process.stdin, patchConsole: false },
    );
    await instance.waitUntilExit();
  } finally {
    process.stderr.write("\u001b[?1049l");
  }
}
