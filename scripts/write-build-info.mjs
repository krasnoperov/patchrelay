import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function getGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

const distDir = path.resolve(process.cwd(), "dist");
mkdirSync(distDir, { recursive: true });

const buildInfo = {
  service: "patchrelay",
  version: process.env.npm_package_version ?? "0.0.0",
  commit: getGitCommit(),
  builtAt: new Date().toISOString(),
};

writeFileSync(path.join(distDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
