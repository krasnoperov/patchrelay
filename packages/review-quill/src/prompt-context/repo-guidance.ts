import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GuidanceDoc } from "../types.ts";

const LOCAL_MARKDOWN_REFERENCE = /(?:\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)|(?<![\w/.-])((?:\.{1,2}\/)?[\w./-]+\.md(?:#[\w.-]+)?))/gi;

function normalizeGuidancePath(reference: string): string | undefined {
  const withoutAnchor = reference.split("#", 1)[0]?.trim();
  if (!withoutAnchor || /^[a-z][a-z0-9+.-]*:/i.test(withoutAnchor)) return undefined;
  const normalized = path.posix.normalize(withoutAnchor.replace(/\\/g, "/"));
  if (normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) return undefined;
  return normalized.replace(/^\.\//, "");
}

function extractLocalMarkdownReferences(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(LOCAL_MARKDOWN_REFERENCE)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    const normalized = normalizeGuidancePath(raw);
    if (normalized) paths.push(normalized);
  }
  return paths;
}

async function readGuidanceDoc(worktreePath: string, relativePath: string): Promise<GuidanceDoc | undefined> {
  try {
    const text = await readFile(path.join(worktreePath, relativePath), "utf8");
    return { path: relativePath, text };
  } catch {
    return undefined;
  }
}

export async function loadRepoGuidanceDocs(
  worktreePath: string,
  reviewDocs: string[],
  explicitReferenceText: string[] = [],
): Promise<GuidanceDoc[]> {
  const paths = [...new Set([...reviewDocs, "AGENTS.md"])];
  const docs: GuidanceDoc[] = [];
  for (const relativePath of paths) {
    const doc = await readGuidanceDoc(worktreePath, relativePath);
    if (doc) docs.push(doc);
  }

  const explicitPaths = explicitReferenceText.flatMap(extractLocalMarkdownReferences);
  for (const relativePath of explicitPaths) {
    if (paths.includes(relativePath)) continue;
    const doc = await readGuidanceDoc(worktreePath, relativePath);
    if (!doc) continue;
    paths.push(relativePath);
    docs.push(doc);
  }
  return docs;
}
