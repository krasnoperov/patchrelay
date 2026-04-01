import { createElement } from "react";
import { render } from "ink";
import { loadConfig } from "../config.ts";
import { App } from "./App.tsx";
import { parseHomeConfigObject } from "../steward-home.ts";
import { getDefaultConfigPath } from "../runtime-paths.ts";
import { readFileSync, existsSync } from "node:fs";

function resolveGatewayBaseUrl(): string {
  const configPath = getDefaultConfigPath();
  if (!existsSync(configPath)) {
    throw new Error("merge-steward home not initialized. Run `merge-steward init` first.");
  }
  const homeConfig = parseHomeConfigObject(readFileSync(configPath, "utf8"), configPath);
  const bind = homeConfig.server.bind === "0.0.0.0" ? "127.0.0.1"
    : homeConfig.server.bind === "::" ? "[::1]"
    : homeConfig.server.bind;
  const port = homeConfig.server.gateway_port ?? (homeConfig.server.port_base - 1);
  return `http://${bind}:${port}`;
}

export async function startWatch(configPath?: string, initialPrNumber?: number): Promise<void> {
  const config = loadConfig(configPath);
  const gatewayBase = resolveGatewayBaseUrl();
  const baseUrl = `${gatewayBase}/repos/${config.repoId}`;

  process.stderr.write("\u001b[?1049h\u001b[2J\u001b[H");
  try {
    const instance = render(
      createElement(App, { baseUrl, ...(initialPrNumber !== undefined ? { initialPrNumber } : {}) }),
      { stdout: process.stderr, stdin: process.stdin, patchConsole: false },
    );

    await instance.waitUntilExit();
  } finally {
    process.stderr.write("\u001b[?1049l");
  }
}
