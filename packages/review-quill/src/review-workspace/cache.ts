import { existsSync } from "node:fs";
import path from "node:path";
import { getReviewQuillPathLayout } from "../runtime-paths.ts";
import { ensureDir } from "../utils.ts";
import { gitCloneBare } from "./git.ts";

function cacheDirName(repoFullName: string): string {
  return `${repoFullName.replaceAll("/", "__")}.git`;
}

function repoUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`;
}

export async function ensureRepoCache(repoFullName: string, token: string): Promise<string> {
  const layout = getReviewQuillPathLayout();
  const cacheRoot = path.join(layout.dataDir, "git-cache");
  await ensureDir(cacheRoot);
  const cachePath = path.join(cacheRoot, cacheDirName(repoFullName));
  if (!existsSync(cachePath)) {
    await gitCloneBare(repoUrl(repoFullName), cachePath, token);
  }
  return cachePath;
}
