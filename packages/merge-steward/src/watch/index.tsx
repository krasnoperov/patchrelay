import { createElement } from "react";
import { render } from "ink";
import { loadConfig } from "../config.ts";
import { App } from "./App.tsx";

function resolveBaseUrl(bind: string, port: number): string {
  if (bind === "0.0.0.0") {
    return `http://127.0.0.1:${port}`;
  }
  if (bind === "::") {
    return `http://[::1]:${port}`;
  }
  if (bind.includes(":") && !bind.startsWith("[")) {
    return `http://[${bind}]:${port}`;
  }
  return `http://${bind}:${port}`;
}

export async function startWatch(configPath?: string, initialPrNumber?: number): Promise<void> {
  const config = loadConfig(configPath);
  const baseUrl = resolveBaseUrl(config.server.bind, config.server.port);

  const instance = render(
    createElement(App, { baseUrl, ...(initialPrNumber !== undefined ? { initialPrNumber } : {}) }),
    { stdout: process.stderr, stdin: process.stdin, patchConsole: false },
  );

  await instance.waitUntilExit();
}
