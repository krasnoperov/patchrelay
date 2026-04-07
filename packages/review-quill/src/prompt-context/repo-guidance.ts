import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GuidanceDoc } from "../types.ts";

export async function loadRepoGuidanceDocs(worktreePath: string, reviewDocs: string[]): Promise<GuidanceDoc[]> {
  const paths = [...new Set(["AGENTS.md", ...reviewDocs])];
  const docs: GuidanceDoc[] = [];
  for (const relativePath of paths) {
    const absolutePath = path.join(worktreePath, relativePath);
    try {
      const text = await readFile(absolutePath, "utf8");
      docs.push({ path: relativePath, text });
    } catch {
      continue;
    }
  }
  return docs;
}
