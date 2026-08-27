import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type EvalExpectedVerdict = "approve" | "request_changes";

export interface ReviewEvalCase {
  id: string;
  sourcePath: string;
  repository: string;
  pullRequest: number;
  baseSha: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  expectedVerdict: EvalExpectedVerdict;
  maximumConcerns: number;
  forbidNits: boolean;
  reviewDocs: string[];
  mustReport: string[][];
  mustNotReport: string[][];
  priorReviewClaims: string[];
  notes: string;
}

const SECTION_NAMES = new Set([
  "Review docs",
  "Must report",
  "Must not report",
  "Prior review claims",
  "Notes",
]);

const METADATA_KEYS = new Set([
  "Repository",
  "Pull request",
  "Base SHA",
  "Head SHA",
  "Base branch",
  "Head branch",
  "Title",
  "Body file",
  "Expected verdict",
  "Maximum concerns",
  "Nits",
]);

function parseList(section: string, splitMarkers = false): string[][] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line && line.toLowerCase() !== "none")
    .map((line) => splitMarkers
      ? line.split(";").map((part) => part.trim()).filter(Boolean)
      : [line]);
}

function requiredMetadata(metadata: Map<string, string>, key: string): string {
  const value = metadata.get(key)?.trim();
  if (!value) throw new Error(`Missing required case field: ${key}`);
  return value;
}

function parsePositiveInteger(value: string, field: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${field} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function validateSha(value: string, field: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${field} must be a full 40-character commit SHA`);
  return value.toLowerCase();
}

export async function loadEvalCase(filePath: string): Promise<ReviewEvalCase> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const titleLine = lines.find((line) => line.startsWith("# "));
  if (!titleLine) throw new Error(`Case ${filePath} must start with a level-one heading`);
  const id = titleLine.slice(2).trim();
  if (!id) throw new Error(`Case ${filePath} has an empty heading`);

  const metadata = new Map<string, string>();
  const sections = new Map<string, string[]>();
  let currentSection: string | undefined;
  for (const line of lines.slice(lines.indexOf(titleLine) + 1)) {
    const sectionMatch = line.match(/^## (.+)$/);
    if (sectionMatch?.[1] && SECTION_NAMES.has(sectionMatch[1])) {
      currentSection = sectionMatch[1];
      sections.set(currentSection, []);
      continue;
    }
    if (currentSection) {
      sections.get(currentSection)?.push(line);
      continue;
    }
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`Invalid case metadata line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!METADATA_KEYS.has(key)) throw new Error(`Unknown case field: ${key}`);
    if (metadata.has(key)) throw new Error(`Duplicate case field: ${key}`);
    metadata.set(key, value);
  }

  const expectedVerdict = requiredMetadata(metadata, "Expected verdict");
  if (expectedVerdict !== "approve" && expectedVerdict !== "request_changes") {
    throw new Error("Expected verdict must be approve or request_changes");
  }
  const nits = requiredMetadata(metadata, "Nits");
  if (nits !== "forbid" && nits !== "allow") throw new Error("Nits must be forbid or allow");

  const bodyFile = requiredMetadata(metadata, "Body file");
  const body = await readFile(path.resolve(path.dirname(filePath), bodyFile), "utf8");
  return {
    id,
    sourcePath: filePath,
    repository: requiredMetadata(metadata, "Repository"),
    pullRequest: parsePositiveInteger(requiredMetadata(metadata, "Pull request"), "Pull request"),
    baseSha: validateSha(requiredMetadata(metadata, "Base SHA"), "Base SHA"),
    headSha: validateSha(requiredMetadata(metadata, "Head SHA"), "Head SHA"),
    baseBranch: requiredMetadata(metadata, "Base branch"),
    headBranch: requiredMetadata(metadata, "Head branch"),
    title: requiredMetadata(metadata, "Title"),
    body: body.trim(),
    expectedVerdict,
    maximumConcerns: parsePositiveInteger(requiredMetadata(metadata, "Maximum concerns"), "Maximum concerns", true),
    forbidNits: nits === "forbid",
    reviewDocs: parseList((sections.get("Review docs") ?? []).join("\n")).flat(),
    mustReport: parseList((sections.get("Must report") ?? []).join("\n"), true),
    mustNotReport: parseList((sections.get("Must not report") ?? []).join("\n"), true),
    priorReviewClaims: parseList((sections.get("Prior review claims") ?? []).join("\n")).flat(),
    notes: (sections.get("Notes") ?? []).join("\n").trim(),
  };
}

export async function loadEvalCases(directory: string): Promise<ReviewEvalCase[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".case.md")).sort();
  if (names.length === 0) throw new Error(`No *.case.md files found in ${directory}`);
  const cases = await Promise.all(names.map((name) => loadEvalCase(path.join(directory, name))));
  const ids = new Set<string>();
  for (const evalCase of cases) {
    if (ids.has(evalCase.id)) throw new Error(`Duplicate eval case id: ${evalCase.id}`);
    ids.add(evalCase.id);
  }
  return cases;
}
