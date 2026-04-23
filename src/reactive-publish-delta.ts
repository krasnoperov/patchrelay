import { execCommand, safeJsonParse } from "./utils.ts";

interface GitHubCompareFile {
  filename?: string;
}

interface GitHubCompareCommit {
  commit?: {
    message?: string;
  };
}

interface GitHubCompareResponse {
  files?: GitHubCompareFile[];
  commits?: GitHubCompareCommit[];
}

export interface ReactivePublishDelta {
  changedFiles: string[];
  commitSubjects: string[];
}

export async function readReactivePublishDelta(
  repoFullName: string,
  baseHeadSha: string,
  publishedHeadSha: string,
): Promise<ReactivePublishDelta | undefined> {
  const { stdout, exitCode } = await execCommand("gh", [
    "api",
    `repos/${repoFullName}/compare/${baseHeadSha}...${publishedHeadSha}`,
  ], { timeoutMs: 10_000 });
  if (exitCode !== 0) {
    return undefined;
  }

  const payload = safeJsonParse<GitHubCompareResponse>(stdout);
  if (!payload) {
    return undefined;
  }

  const changedFiles = (payload.files ?? [])
    .map((entry) => entry.filename?.trim())
    .filter((entry): entry is string => Boolean(entry));
  const commitSubjects = (payload.commits ?? [])
    .map((entry) => firstLine(entry.commit?.message))
    .filter((entry): entry is string => Boolean(entry));

  return {
    changedFiles,
    commitSubjects,
  };
}

function firstLine(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\r?\n/, 1)[0]?.trim() || undefined;
}
