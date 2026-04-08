import { deriveGateCheckStatusFromRollup, type GitHubStatusRollupEntry } from "../github-rollup.ts";
import { ACTIVE_RUN_STATES } from "../factory-state.ts";
import type { PatchRelayDatabase } from "../db.ts";
import type { IssueDependencyRecord, IssueRecord, IssueSessionRecord } from "../db-types.ts";
import type { AppConfig } from "../types.ts";
import type { CommandRunner, CommandRunnerResult } from "./command-types.ts";

const RECONCILIATION_GRACE_MS = 120_000;
const DOWNSTREAM_STALE_MS = 900_000;

export interface ClusterHealthCheck {
  status: "pass" | "warn" | "fail";
  scope: string;
  message: string;
  issueKey?: string | undefined;
  projectId?: string | undefined;
  prNumber?: number | undefined;
}

export interface ClusterHealthSummary {
  trackedIssues: number;
  openIssues: number;
  activeRuns: number;
  blockedIssues: number;
  readyIssues: number;
  passCount: number;
  warnCount: number;
  failCount: number;
}

export interface ClusterHealthReport {
  generatedAt: string;
  ok: boolean;
  summary: ClusterHealthSummary;
  checks: ClusterHealthCheck[];
}

interface ServiceProbeResult {
  status: "pass" | "warn" | "fail";
  message: string;
}

interface GitHubPullRequestSnapshot {
  state?: string | undefined;
  reviewDecision?: string | undefined;
  mergeable?: string | undefined;
  mergeStateStatus?: string | undefined;
  headRefOid?: string | undefined;
  reviewRequests?: unknown[] | undefined;
  statusCheckRollup?: GitHubStatusRollupEntry[] | undefined;
}

interface IssueSnapshot {
  issue: IssueRecord;
  session?: IssueSessionRecord | undefined;
  blockedBy: IssueDependencyRecord[];
  missingTrackedBlockers: IssueDependencyRecord[];
  ageMs: number;
  readyForExecution: boolean;
}

export async function collectClusterHealth(
  config: AppConfig,
  db: PatchRelayDatabase,
  runCommand: CommandRunner,
): Promise<ClusterHealthReport> {
  const checks: ClusterHealthCheck[] = [];
  const now = Date.now();
  const issues = db.listIssues();
  const openIssues = issues.filter((issue) => issue.factoryState !== "done");
  const trackedByKey = new Map(
    issues
      .filter((issue) => issue.issueKey)
      .map((issue) => [issue.issueKey!, issue]),
  );
  const trackedByLinearId = new Map(issues.map((issue) => [issue.linearIssueId, issue]));

  const patchRelayProbe = await probePatchRelayService(config);
  checks.push({
    status: patchRelayProbe.status,
    scope: "service:patchrelay",
    message: patchRelayProbe.message,
  });

  const snapshots = openIssues.map((issue) => {
    const tracked = db.getTrackedIssue(issue.projectId, issue.linearIssueId);
    const deps = db.listIssueDependencies(issue.projectId, issue.linearIssueId);
    const blockedBy = deps.filter((dep) => !isResolvedDependency(dep));
    const missingTrackedBlockers = blockedBy.filter((dep) => {
      if (trackedByLinearId.has(dep.blockerLinearIssueId)) return false;
      if (dep.blockerIssueKey && trackedByKey.has(dep.blockerIssueKey)) return false;
      return true;
    });
    return {
      issue,
      session: db.getIssueSession(issue.projectId, issue.linearIssueId),
      blockedBy,
      missingTrackedBlockers,
      ageMs: Math.max(0, now - Date.parse(issue.updatedAt || new Date(0).toISOString())),
      readyForExecution: tracked?.readyForExecution ?? false,
    } satisfies IssueSnapshot;
  });

  const reviewRelevantIssues = snapshots.filter((snapshot) => needsReviewAutomation(snapshot.issue));
  const queueRelevantIssues = snapshots.filter((snapshot) => snapshot.issue.factoryState === "awaiting_queue");
  const reviewQuillProbe = reviewRelevantIssues.length > 0
    ? await probeOptionalService(runCommand, "review-quill", {
        healthy: (payload) => payload?.health?.ok === true && payload?.systemd?.ActiveState === "active",
        summarize: (payload) => payload?.health?.ok === true
          ? `Healthy (${typeof payload?.watch?.runningAttempts === "number" ? `${payload.watch.runningAttempts} running attempts` : "service reachable"})`
          : `Unhealthy (${payload?.healthError ?? "service health unavailable"})`,
      })
    : undefined;
  if (reviewQuillProbe) {
    checks.push({
      status: reviewQuillProbe.status,
      scope: "service:review-quill",
      message: reviewQuillProbe.message,
    });
  }

  const mergeStewardProbe = queueRelevantIssues.length > 0
    ? await probeOptionalService(runCommand, "merge-steward", {
        healthy: (payload) => payload?.systemd?.ActiveState === "active",
        summarize: (payload) => payload?.systemd?.ActiveState === "active"
          ? "Healthy"
          : `Unhealthy (${payload?.systemd?.ActiveState ?? "unknown"})`,
      })
    : undefined;
  if (mergeStewardProbe) {
    checks.push({
      status: mergeStewardProbe.status,
      scope: "service:merge-steward",
      message: mergeStewardProbe.message,
    });
  }

  for (const snapshot of snapshots) {
    const finding = evaluateLocalIssueHealth(snapshot);
    if (finding) {
      checks.push({
        ...finding,
        ...(snapshot.issue.issueKey ? { issueKey: snapshot.issue.issueKey } : {}),
        projectId: snapshot.issue.projectId,
        ...(snapshot.issue.prNumber !== undefined ? { prNumber: snapshot.issue.prNumber } : {}),
      });
    }
  }

  for (const snapshot of snapshots) {
    if (!snapshot.issue.prNumber) {
      continue;
    }
    const finding = await evaluateGitHubIssueHealth(
      snapshot,
      config,
      runCommand,
      reviewQuillProbe,
      mergeStewardProbe,
    );
    if (finding) {
      checks.push({
        ...finding,
        ...(snapshot.issue.issueKey ? { issueKey: snapshot.issue.issueKey } : {}),
        projectId: snapshot.issue.projectId,
        prNumber: snapshot.issue.prNumber,
      });
    }
  }

  const workflowFailures = checks.filter((check) => check.scope.startsWith("issue:") || check.scope.startsWith("github:"));
  if (workflowFailures.every((check) => check.status === "pass" || check.status === "warn") && openIssues.length > 0) {
    checks.push({
      status: "pass",
      scope: "workflow",
      message: `All ${openIssues.length} non-done issues have a live owner, a valid blocker, or a current downstream waiter`,
    });
  }
  if (openIssues.length === 0) {
    checks.push({
      status: "pass",
      scope: "workflow",
      message: "No non-done issues are currently tracked",
    });
  }

  const summary: ClusterHealthSummary = {
    trackedIssues: issues.length,
    openIssues: openIssues.length,
    activeRuns: openIssues.filter((issue) => issue.activeRunId !== undefined).length,
    blockedIssues: snapshots.filter((snapshot) => snapshot.blockedBy.length > 0).length,
    readyIssues: snapshots.filter((snapshot) => snapshot.readyForExecution).length,
    passCount: checks.filter((check) => check.status === "pass").length,
    warnCount: checks.filter((check) => check.status === "warn").length,
    failCount: checks.filter((check) => check.status === "fail").length,
  };

  return {
    generatedAt: new Date().toISOString(),
    ok: summary.failCount === 0,
    summary,
    checks,
  };
}

function evaluateLocalIssueHealth(snapshot: IssueSnapshot): ClusterHealthCheck | undefined {
  const { issue, session, missingTrackedBlockers, blockedBy, ageMs, readyForExecution } = snapshot;
  if (issue.factoryState === "failed" || issue.factoryState === "escalated") {
    return {
      status: "fail",
      scope: "issue:terminal",
      message: `Issue is in terminal failure state ${issue.factoryState}`,
    };
  }

  if (missingTrackedBlockers.length > 0) {
    return {
      status: "fail",
      scope: "issue:blockers",
      message: `Blocked by unmanaged issue${missingTrackedBlockers.length === 1 ? "" : "s"} ${missingTrackedBlockers.map((dep) => dep.blockerIssueKey ?? dep.blockerLinearIssueId).join(", ")}`,
    };
  }

  if (issue.activeRunId !== undefined && session?.sessionState !== "running") {
    return {
      status: "fail",
      scope: "issue:run-state",
      message: `Issue has active run #${issue.activeRunId} but session state is ${session?.sessionState ?? "missing"}`,
    };
  }

  if (issue.activeRunId === undefined && session?.sessionState === "running") {
    return {
      status: "fail",
      scope: "issue:run-state",
      message: "Issue session is marked running but no active run is attached",
    };
  }

  if (blockedBy.length > 0) {
    return undefined;
  }

  if (readyForExecution && issue.activeRunId === undefined && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "issue:dispatch",
      message: "Issue is ready for execution but no active run has started",
    };
  }

  if (ACTIVE_RUN_STATES.has(issue.factoryState) && issue.activeRunId === undefined && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "issue:dispatch",
      message: `Issue is parked in ${issue.factoryState} without an active run`,
    };
  }

  if (issue.factoryState === "delegated" && issue.activeRunId === undefined && !readyForExecution && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "issue:dispatch",
      message: "Delegated issue is idle but no wake is queued",
    };
  }

  if (issue.factoryState === "awaiting_input" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "warn",
      scope: "issue:operator",
      message: "Issue is waiting on operator input",
    };
  }

  if (issue.factoryState === "awaiting_queue" && ageMs >= DOWNSTREAM_STALE_MS) {
    return {
      status: "warn",
      scope: "issue:downstream",
      message: "Issue has been waiting on downstream merge automation for a long time",
    };
  }

  return undefined;
}

async function evaluateGitHubIssueHealth(
  snapshot: IssueSnapshot,
  config: AppConfig,
  runCommand: CommandRunner,
  reviewQuillProbe?: ServiceProbeResult,
  mergeStewardProbe?: ServiceProbeResult,
): Promise<ClusterHealthCheck | undefined> {
  const { issue, ageMs } = snapshot;
  const project = config.projects.find((entry) => entry.id === issue.projectId);
  const repoFullName = project?.github?.repoFullName;
  if (!repoFullName || issue.prNumber === undefined) {
    return issue.prNumber !== undefined
      ? {
          status: "fail",
          scope: "github:config",
          message: "PR-backed issue has no GitHub repo configured",
        }
      : undefined;
  }

  const probe = await probeGitHubPullRequest(runCommand, repoFullName, issue.prNumber);
  if (!probe.ok) {
    return {
      status: "warn",
      scope: "github:probe",
      message: `Unable to query GitHub PR state: ${probe.error}`,
    };
  }

  const pr = probe.pr;
  const gateCheckNames = getGateCheckNames(project);
  const gateCheckStatus = deriveGateCheckStatusFromRollup(pr.statusCheckRollup, gateCheckNames);
  const reviewDecision = pr.reviewDecision?.trim().toUpperCase();
  const requestedReviewers = extractRequestedReviewerLogins(pr.reviewRequests);
  const reviewRequested = requestedReviewers.length > 0;
  const mergeConflictDetected = pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY";

  if (pr.state === "MERGED" && issue.factoryState !== "done" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "github:reconcile",
      message: "PR is already merged but the issue has not advanced to done",
    };
  }

  if (pr.state === "CLOSED" && issue.factoryState !== "delegated" && issue.factoryState !== "done" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "github:reconcile",
      message: "PR is closed but the issue is still waiting on PR state",
    };
  }

  if (gateCheckStatus === "failure" && issue.factoryState !== "repairing_ci" && issue.activeRunId === undefined && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "github:ci",
      message: "Gate CI is failing but no CI repair is running or queued",
    };
  }

  if (reviewDecision === "APPROVED" && issue.factoryState !== "awaiting_queue" && issue.factoryState !== "done" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "github:reconcile",
      message: "PR is approved but the issue has not handed off to downstream merge automation",
    };
  }

  if (gateCheckStatus === "success" && reviewDecision === "CHANGES_REQUESTED" && !reviewRequested && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "github:review-handoff",
      message: "PR is waiting on re-review but no reviewer is currently requested",
    };
  }

  if (gateCheckStatus === "success" && reviewDecision === "REVIEW_REQUIRED" && !reviewRequested && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "github:review-handoff",
      message: "PR needs review but no reviewer is currently requested",
    };
  }

  if (requestedReviewers.includes("review-quill") && reviewQuillProbe && reviewQuillProbe.status !== "pass") {
    return {
      status: "fail",
      scope: "github:review-automation",
      message: `PR is waiting on review-quill but the service is not healthy: ${reviewQuillProbe.message}`,
    };
  }

  if (issue.factoryState === "awaiting_queue" && mergeConflictDetected && issue.activeRunId === undefined && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "github:queue",
      message: "PR has merge conflicts but no queue repair is running or queued",
    };
  }

  if (issue.factoryState === "awaiting_queue" && mergeStewardProbe && mergeStewardProbe.status !== "pass" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "github:queue",
      message: `Issue is waiting on downstream merge automation but merge-steward is not healthy: ${mergeStewardProbe.message}`,
    };
  }

  return undefined;
}

function isResolvedDependency(dep: IssueDependencyRecord): boolean {
  return dep.blockerCurrentLinearStateType === "completed" || dep.blockerCurrentLinearState?.trim().toLowerCase() === "done";
}

function needsReviewAutomation(issue: IssueRecord): boolean {
  if (issue.factoryState === "awaiting_queue" || issue.factoryState === "done") {
    return false;
  }
  return issue.prNumber !== undefined;
}

function getGateCheckNames(project: AppConfig["projects"][number] | undefined): string[] {
  const configured = project?.gateChecks?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  return configured.length > 0 ? configured : ["verify"];
}

async function probePatchRelayService(config: AppConfig): Promise<ServiceProbeResult> {
  const host = config.server.bind === "0.0.0.0" ? "127.0.0.1" : config.server.bind;
  const healthUrl = `http://${host}:${config.server.port}${config.server.healthPath}`;
  const readyUrl = `http://${host}:${config.server.port}${config.server.readinessPath}`;
  try {
    const [healthResponse, readyResponse] = await Promise.all([
      fetch(healthUrl, { signal: AbortSignal.timeout(2_000) }),
      fetch(readyUrl, { signal: AbortSignal.timeout(2_000) }),
    ]);
    const healthBody = await healthResponse.json() as { ok?: boolean; version?: string };
    const readyBody = await readyResponse.json() as { ready?: boolean; codexStarted?: boolean; linearConnected?: boolean };
    if (healthResponse.ok && readyResponse.ok && readyBody.ready) {
      return {
        status: "pass",
        message: `Healthy${healthBody.version ? ` (v${healthBody.version})` : ""}`,
      };
    }
    return {
      status: "fail",
      message: `Reachable but not ready${readyBody.codexStarted === false || readyBody.linearConnected === false
        ? ` (${[
          readyBody.codexStarted === false ? "codex not started" : undefined,
          readyBody.linearConnected === false ? "Linear not connected" : undefined,
        ].filter(Boolean).join(", ")})`
        : ""}`,
    };
  } catch (error) {
    return {
      status: "fail",
      message: `Unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function probeOptionalService(
  runCommand: CommandRunner,
  binary: string,
  options: {
    healthy: (payload: Record<string, any>) => boolean;
    summarize: (payload: Record<string, any>) => string;
  },
): Promise<ServiceProbeResult> {
  let result: CommandRunnerResult;
  try {
    result = await runCommand(binary, ["service", "status", "--json"]);
  } catch (error) {
    return {
      status: "warn",
      message: `Unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (result.exitCode !== 0) {
    const errorText = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" ");
    return {
      status: "warn",
      message: `Unavailable: ${errorText || `${binary} service status exited ${result.exitCode}`}`,
    };
  }

  const payload = safeJsonParse(result.stdout);
  if (!payload) {
    return {
      status: "warn",
      message: "Unavailable: unable to parse JSON status output",
    };
  }

  return {
    status: options.healthy(payload) ? "pass" : "fail",
    message: options.summarize(payload),
  };
}

async function probeGitHubPullRequest(
  runCommand: CommandRunner,
  repoFullName: string,
  prNumber: number,
): Promise<{ ok: true; pr: GitHubPullRequestSnapshot } | { ok: false; error: string }> {
  let result: CommandRunnerResult;
  try {
    result = await runCommand("gh", [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repoFullName,
      "--json",
      "state,reviewDecision,reviewRequests,statusCheckRollup,mergeable,mergeStateStatus,headRefOid",
    ]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" ") || `gh exited ${result.exitCode}`,
    };
  }

  const parsed = safeJsonParse(result.stdout);
  if (!parsed) {
    return { ok: false, error: "invalid JSON from gh pr view" };
  }

  return { ok: true, pr: parsed as GitHubPullRequestSnapshot };
}

function extractRequestedReviewerLogins(requests: unknown[] | undefined): string[] {
  if (!Array.isArray(requests)) {
    return [];
  }
  const logins = requests.flatMap((request) => {
    if (!request || typeof request !== "object") {
      return [];
    }
    const direct = typeof (request as { login?: unknown }).login === "string"
      ? String((request as { login: string }).login)
      : undefined;
    const nested = typeof (request as { requestedReviewer?: { login?: unknown } }).requestedReviewer?.login === "string"
      ? String((request as { requestedReviewer: { login: string } }).requestedReviewer.login)
      : undefined;
    return [direct, nested].filter((entry): entry is string => Boolean(entry)).map((entry) => entry.trim().toLowerCase());
  });
  return [...new Set(logins)];
}

function safeJsonParse(value: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : undefined;
  } catch {
    return undefined;
  }
}
