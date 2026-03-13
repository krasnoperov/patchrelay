import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getBundledAssetPath } from "./runtime-paths.ts";

export interface BuildInfo {
  service: string;
  version: string;
  commit: string;
  builtAt: string;
}

interface BuildInfoPaths {
  bundledPath?: string;
  cwdPath?: string;
}

const fallbackBuildInfo: BuildInfo = {
  service: "patchrelay",
  version: "0.1.0",
  commit: "unknown",
  builtAt: "unknown",
};

export function getBuildInfo(paths?: BuildInfoPaths): BuildInfo {
  const fallbackPath = paths?.bundledPath ?? getBundledAssetPath("dist/build-info.json");
  const cwdBuildInfoPath = paths?.cwdPath ?? path.resolve(process.cwd(), "dist/build-info.json");
  const resolvedPath = existsSync(fallbackPath) ? fallbackPath : cwdBuildInfoPath;
  if (!existsSync(resolvedPath)) {
    return fallbackBuildInfo;
  }

  try {
    const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as Partial<BuildInfo>;
    return {
      service: typeof parsed.service === "string" ? parsed.service : fallbackBuildInfo.service,
      version: typeof parsed.version === "string" ? parsed.version : fallbackBuildInfo.version,
      commit: typeof parsed.commit === "string" ? parsed.commit : fallbackBuildInfo.commit,
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : fallbackBuildInfo.builtAt,
    };
  } catch {
    return fallbackBuildInfo;
  }
}
