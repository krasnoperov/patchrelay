import type { AppConfig } from "../../types.ts";
import type { CommandRunner, CommandRunnerResult } from "../command-types.ts";
import { probeGitHubPullRequest } from "./github-probe.ts";
import { type JsonObject, safeJsonParse } from "./shared.ts";
import type { IssueSnapshot, ReviewQuillAttemptOwnership } from "./types.ts";

export interface ReviewQuillStatusJson extends JsonObject {
  health?: { reachable?: boolean; ok?: boolean; codexLimitedUntil?: string | null } | undefined;
  systemd?: { ActiveState?: string } | undefined;
  runtime?: { reconcileInProgress?: boolean } | undefined;
  repos?: unknown[] | undefined;
}

export interface ReviewQuillAttemptsJson extends JsonObject {
  attempts?: unknown[] | undefined;
}

export type ReviewQuillAttemptsProbeResult =
  | {
      ok: true;
      currentHeadSha?: string | undefined;
      latestAttemptHeadSha?: string | undefined;
      attempts: Array<{ id: number; headSha: string; status: "queued" | "running"; stale: boolean }>;
    }
  | { ok: false; error: string };

export async function collectReviewQuillAttemptOwners(
  snapshots: IssueSnapshot[],
  config: AppConfig,
  runCommand: CommandRunner,
): Promise<Map<string, ReviewQuillAttemptOwnership>> {
  const owners = new Map<string, ReviewQuillAttemptOwnership>();
  const repoBacklog = await probeReviewQuillRepoBacklog(runCommand);

  for (const snapshot of snapshots) {
    const issueKey = snapshot.issue.issueKey;
    const prNumber = snapshot.issue.prNumber;
    if (!issueKey || prNumber === undefined) continue;

    const project = config.projects.find((entry) => entry.id === snapshot.issue.projectId);
    const repoFullName = project?.github?.repoFullName;
    if (!repoFullName) continue;

    const probe = await probeReviewQuillAttempts(runCommand, repoFullName, prNumber);
    if (!probe.ok) continue;

    const activeAttempt = probe.attempts.find((attempt) =>
      (attempt.status === "queued" || attempt.status === "running")
      && !attempt.stale
      && attempt.headSha === probe.currentHeadSha
    );
    if (!activeAttempt) {
      if (repoBacklog.has(repoFullName)) {
        owners.set(issueKey, { backlog: true, headSha: probe.latestAttemptHeadSha });
      }
      continue;
    }

    owners.set(issueKey, {
      id: activeAttempt.id,
      status: activeAttempt.status,
      headSha: activeAttempt.headSha,
    });
  }

  return owners;
}

export async function probeReviewQuillRepoBacklog(
  runCommand: CommandRunner,
): Promise<Set<string>> {
  let result: CommandRunnerResult;
  try {
    result = await runCommand("review-quill", ["status", "--json"]);
  } catch {
    return new Set();
  }

  if (result.exitCode !== 0) {
    return new Set();
  }

  const parsed = safeJsonParse(result.stdout) as ReviewQuillStatusJson | undefined;
  if (!parsed || parsed.runtime?.reconcileInProgress !== true || !Array.isArray(parsed.repos)) {
    return new Set();
  }

  const activeRepos = new Set<string>();
  for (const repo of parsed.repos) {
    if (!repo || typeof repo !== "object") continue;
    const repoFullName = typeof (repo as { repoFullName?: unknown }).repoFullName === "string"
      ? String((repo as { repoFullName: string }).repoFullName).trim()
      : undefined;
    const runningAttempts = typeof (repo as { runningAttempts?: unknown }).runningAttempts === "number"
      ? Number((repo as { runningAttempts: number }).runningAttempts)
      : 0;
    const queuedAttempts = typeof (repo as { queuedAttempts?: unknown }).queuedAttempts === "number"
      ? Number((repo as { queuedAttempts: number }).queuedAttempts)
      : 0;
    if (!repoFullName) continue;
    if (runningAttempts > 0 || queuedAttempts > 0) {
      activeRepos.add(repoFullName);
    }
  }

  return activeRepos;
}

export async function probeReviewQuillAttempts(
  runCommand: CommandRunner,
  repoFullName: string,
  prNumber: number,
): Promise<ReviewQuillAttemptsProbeResult> {
  const repoRef = repoFullName.split("/").at(-1);
  if (!repoRef) {
    return { ok: false, error: `Unable to derive review-quill repo id from ${repoFullName}` };
  }

  let attemptsResult: CommandRunnerResult;
  try {
    attemptsResult = await runCommand("review-quill", ["attempts", repoRef, String(prNumber), "--json"]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (attemptsResult.exitCode !== 0) {
    return {
      ok: false,
      error: [attemptsResult.stderr.trim(), attemptsResult.stdout.trim()].filter(Boolean).join(" ") || `review-quill exited ${attemptsResult.exitCode}`,
    };
  }

  const parsedAttempts = safeJsonParse(attemptsResult.stdout) as ReviewQuillAttemptsJson | undefined;
  if (!parsedAttempts || !Array.isArray(parsedAttempts.attempts)) {
    return { ok: false, error: "invalid JSON from review-quill attempts" };
  }

  const prProbe = await probeGitHubPullRequest(runCommand, repoFullName, prNumber);
  if (!prProbe.ok) {
    return { ok: false, error: prProbe.error };
  }

  let latestAttemptHeadSha: string | undefined;
  const attempts = parsedAttempts.attempts.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    const headSha = (entry as { headSha?: unknown }).headSha;
    const status = (entry as { status?: unknown }).status;
    const stale = (entry as { stale?: unknown }).stale;
    if (!latestAttemptHeadSha && typeof headSha === "string" && headSha.trim().length > 0) {
      latestAttemptHeadSha = headSha.trim();
    }
    if (
      typeof id !== "number"
      || typeof headSha !== "string"
      || (status !== "queued" && status !== "running")
    ) {
      return [];
    }
    return [{
      id,
      headSha,
      status: status as "queued" | "running",
      stale: stale === true,
    }];
  });

  return {
    ok: true,
    currentHeadSha: prProbe.pr.headRefOid,
    latestAttemptHeadSha,
    attempts,
  };
}
