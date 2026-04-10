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
  ciTrackedPrs: number;
  ciPending: number;
  ciSuccess: number;
  ciFailure: number;
  ciUnknown: number;
  ciOrphaned: number;
  passCount: number;
  warnCount: number;
  failCount: number;
}

export interface ClusterCiEntry {
  issueKey?: string | undefined;
  projectId: string;
  prNumber: number;
  gateStatus: "pending" | "success" | "failure" | "unknown";
  owner: "patchrelay" | "reviewer" | "review-quill" | "downstream" | "external" | "paused" | "unknown";
  orphaned: boolean;
  factoryState: string;
  reviewDecision?: string | undefined;
  message: string;
}

export interface ClusterHealthReport {
  generatedAt: string;
  ok: boolean;
  summary: ClusterHealthSummary;
  checks: ClusterHealthCheck[];
  ci: ClusterCiEntry[];
}

interface ServiceProbeResult {
  status: "pass" | "warn" | "fail";
  message: string;
}

type JsonObject = Record<string, unknown>;

interface ReviewQuillStatusJson extends JsonObject {
  health?: { reachable?: boolean; ok?: boolean } | undefined;
  systemd?: { ActiveState?: string } | undefined;
}

interface ReviewQuillAttemptsJson extends JsonObject {
  attempts?: unknown[] | undefined;
}

interface MergeStewardStatusJson extends JsonObject {
  health?: { reachable?: boolean; ok?: boolean } | undefined;
  systemd?: { ActiveState?: string } | undefined;
}

interface GitHubPullRequestSnapshot {
  state?: string | undefined;
  reviewDecision?: string | undefined;
  mergeable?: string | undefined;
  mergeStateStatus?: string | undefined;
  headRefOid?: string | undefined;
  reviewRequests?: unknown[] | undefined;
  latestReviews?: unknown[] | undefined;
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

interface ReviewQuillAttemptOwnership {
  id: number;
  status: "queued" | "running";
  headSha: string;
}

interface ActiveWorktreeDiff {
  issue: IssueRecord;
  files: Set<string>;
}

export async function collectClusterHealth(
  config: AppConfig,
  db: PatchRelayDatabase,
  runCommand: CommandRunner,
): Promise<ClusterHealthReport> {
  const checks: ClusterHealthCheck[] = [];
  const ciEntries: ClusterCiEntry[] = [];
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
    const deps = db.issues.listIssueDependencies(issue.projectId, issue.linearIssueId);
    const blockedBy = deps.filter((dep) => !isResolvedDependency(dep));
    const missingTrackedBlockers = blockedBy.filter((dep) => {
      if (trackedByLinearId.has(dep.blockerLinearIssueId)) return false;
      if (dep.blockerIssueKey && trackedByKey.has(dep.blockerIssueKey)) return false;
      return true;
    });
    return {
      issue,
      session: db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId),
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
        healthy: (payload) => {
          const parsed = payload as ReviewQuillStatusJson;
          return parsed.health?.reachable === true && parsed.health?.ok === true && parsed.systemd?.ActiveState === "active";
        },
        summarize: (payload) => {
          const parsed = payload as ReviewQuillStatusJson;
          return parsed.health?.reachable === true && parsed.health?.ok === true
            ? "Healthy"
            : `Unhealthy (${parsed.health?.reachable === false ? "service not reachable" : "service health unavailable"})`;
        },
      })
    : undefined;
  if (reviewQuillProbe) {
    checks.push({
      status: reviewQuillProbe.status,
      scope: "service:review-quill",
      message: reviewQuillProbe.message,
    });
  }

  const reviewQuillAttemptOwners = reviewQuillProbe?.status === "pass"
    ? await collectReviewQuillAttemptOwners(reviewRelevantIssues, config, runCommand)
    : new Map<string, ReviewQuillAttemptOwnership>();

  const mergeStewardProbe = queueRelevantIssues.length > 0
    ? await probeOptionalService(runCommand, "merge-steward", {
        healthy: (payload) => {
          const parsed = payload as MergeStewardStatusJson;
          return parsed.health?.reachable === true && parsed.health?.ok === true && parsed.systemd?.ActiveState === "active";
        },
        summarize: (payload) => {
          const parsed = payload as MergeStewardStatusJson;
          return parsed.health?.reachable === true && parsed.health?.ok === true && parsed.systemd?.ActiveState === "active"
            ? "Healthy"
            : `Unhealthy (${parsed.health?.reachable === false ? "service not reachable" : parsed.systemd?.ActiveState ?? "unknown"})`;
        },
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

  checks.push(...await collectActiveOverlapFindings(snapshots, runCommand));

  for (const snapshot of snapshots) {
    if (!snapshot.issue.prNumber) {
      continue;
    }
    const githubHealth = await evaluateGitHubIssueHealth(
      snapshot,
      config,
      runCommand,
      reviewQuillProbe,
      reviewQuillAttemptOwners,
      mergeStewardProbe,
    );
    if (githubHealth.ciEntry) {
      ciEntries.push(githubHealth.ciEntry);
    }
    if (githubHealth.finding) {
      checks.push({
        ...githubHealth.finding,
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
      message: `All ${openIssues.length} non-done issues currently have active work, a tracked blocker, or a downstream owner`,
    });
  }
  if (openIssues.length === 0) {
    checks.push({
      status: "pass",
      scope: "workflow",
      message: "No non-done issues are currently tracked",
    });
  }
  if (ciEntries.length > 0) {
    const orphanedCi = ciEntries.filter((entry) => entry.orphaned);
    checks.push({
      status: orphanedCi.length === 0 ? "pass" : "fail",
      scope: "ci",
      message: orphanedCi.length === 0
        ? `Tracked ${ciEntries.length} PR-backed issue${ciEntries.length === 1 ? "" : "s"} and each PR has a visible next owner`
        : `${orphanedCi.length} PR-backed issue${orphanedCi.length === 1 ? "" : "s"} ha${orphanedCi.length === 1 ? "s" : "ve"} no visible next owner`,
    });
  }

  const summary: ClusterHealthSummary = {
    trackedIssues: issues.length,
    openIssues: openIssues.length,
    activeRuns: openIssues.filter((issue) => issue.activeRunId !== undefined).length,
    blockedIssues: snapshots.filter((snapshot) => snapshot.blockedBy.length > 0).length,
    readyIssues: snapshots.filter((snapshot) => snapshot.readyForExecution).length,
    ciTrackedPrs: ciEntries.length,
    ciPending: ciEntries.filter((entry) => entry.gateStatus === "pending").length,
    ciSuccess: ciEntries.filter((entry) => entry.gateStatus === "success").length,
    ciFailure: ciEntries.filter((entry) => entry.gateStatus === "failure").length,
    ciUnknown: ciEntries.filter((entry) => entry.gateStatus === "unknown").length,
    ciOrphaned: ciEntries.filter((entry) => entry.orphaned).length,
    passCount: checks.filter((check) => check.status === "pass").length,
    warnCount: checks.filter((check) => check.status === "warn").length,
    failCount: checks.filter((check) => check.status === "fail").length,
  };

  return {
    generatedAt: new Date().toISOString(),
    ok: summary.failCount === 0,
    summary,
    checks,
    ci: ciEntries,
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
  reviewQuillAttemptOwners?: Map<string, ReviewQuillAttemptOwnership>,
  mergeStewardProbe?: ServiceProbeResult,
): Promise<{ finding?: ClusterHealthCheck | undefined; ciEntry?: ClusterCiEntry | undefined }> {
  const { issue, ageMs } = snapshot;
  const project = config.projects.find((entry) => entry.id === issue.projectId);
  const repoFullName = project?.github?.repoFullName;
  if (!repoFullName || issue.prNumber === undefined) {
    return {
      finding: issue.prNumber !== undefined
        ? {
            status: "fail",
            scope: "github:config",
            message: "PR-backed issue has no GitHub repo configured",
          }
        : undefined,
    };
  }

  const probe = await probeGitHubPullRequest(runCommand, repoFullName, issue.prNumber);
  if (!probe.ok) {
    return {
      ciEntry: {
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        projectId: issue.projectId,
        prNumber: issue.prNumber,
        gateStatus: "unknown",
        owner: "unknown",
        orphaned: true,
        factoryState: issue.factoryState,
        message: `GitHub probe failed: ${probe.error}`,
      },
      finding: {
        status: "warn",
        scope: "github:probe",
        message: `Unable to query GitHub PR state: ${probe.error}`,
      },
    };
  }

  const pr = probe.pr;
  const gateCheckNames = getGateCheckNames(project);
  const gateCheckStatus = deriveCiGateStatus(pr.statusCheckRollup, gateCheckNames);
  const reviewDecision = pr.reviewDecision?.trim().toUpperCase();
  const requestedReviewers = extractRequestedReviewerLogins(pr.reviewRequests);
  const reviewRequested = requestedReviewers.length > 0;
  const latestBlockingReviewHeadSha = extractLatestBlockingReviewHeadSha(pr.latestReviews);
  const mergeConflictDetected = pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY";
  const reviewQuillAttempt = issue.issueKey ? reviewQuillAttemptOwners?.get(issue.issueKey) : undefined;
  const ciEntry = buildCiEntry({
    issue,
    delegatedToPatchRelay: issue.delegatedToPatchRelay,
    gateCheckStatus,
    reviewDecision,
    reviewRequested,
    currentHeadSha: pr.headRefOid,
    latestBlockingReviewHeadSha,
    mergeConflictDetected,
    reviewQuillAttempt,
  });

  if (pr.state === "MERGED" && issue.factoryState !== "done" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:reconcile",
        message: "PR is already merged but the issue has not advanced to done",
      },
    };
  }

  if (pr.state === "CLOSED" && issue.factoryState !== "delegated" && issue.factoryState !== "done" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:reconcile",
        message: "PR is closed but the issue is still waiting on PR state",
      },
    };
  }

  if (
    issue.delegatedToPatchRelay
    && gateCheckStatus === "failure"
    && issue.factoryState !== "repairing_ci"
    && issue.activeRunId === undefined
    && ageMs >= RECONCILIATION_GRACE_MS
  ) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:ci",
        message: "Gate CI is failing but no CI repair is running or queued",
      },
    };
  }

  if (reviewDecision === "APPROVED" && issue.factoryState !== "awaiting_queue" && issue.factoryState !== "done" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:reconcile",
        message: "PR is approved but the issue has not handed off to downstream merge automation",
      },
    };
  }

  if (
    gateCheckStatus === "success"
    && reviewDecision === "CHANGES_REQUESTED"
    && mergeConflictDetected
    && issue.delegatedToPatchRelay
    && issue.factoryState !== "changes_requested"
    && issue.activeRunId === undefined
    && ageMs >= RECONCILIATION_GRACE_MS
  ) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:branch-upkeep",
        message: "PR is still dirty after requested changes, but no branch-upkeep run is active",
      },
    };
  }

  if (
    gateCheckStatus === "success"
    && reviewDecision === "CHANGES_REQUESTED"
    && latestBlockingReviewHeadSha === pr.headRefOid
    && !reviewQuillAttempt
    && issue.delegatedToPatchRelay
    && issue.factoryState !== "changes_requested"
    && ageMs >= RECONCILIATION_GRACE_MS
  ) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:review-handoff",
        message: "Requested changes still block the current head, but no review fix is running",
      },
    };
  }

  if (requestedReviewers.includes("review-quill") && reviewQuillProbe && reviewQuillProbe.status !== "pass") {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:review-automation",
        message: `PR is waiting on review-quill but the service is not healthy: ${reviewQuillProbe.message}`,
      },
    };
  }

  if (
    issue.delegatedToPatchRelay
    && issue.factoryState === "awaiting_queue"
    && mergeConflictDetected
    && issue.activeRunId === undefined
    && ageMs >= RECONCILIATION_GRACE_MS
  ) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:queue",
        message: "PR has merge conflicts but no queue repair is running or queued",
      },
    };
  }

  if (issue.factoryState === "awaiting_queue" && mergeStewardProbe && mergeStewardProbe.status !== "pass" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:queue",
        message: `Issue is waiting on downstream merge automation but merge-steward is not healthy: ${mergeStewardProbe.message}`,
      },
    };
  }

  return { ciEntry };
}

function buildCiEntry(params: {
  issue: IssueRecord;
  delegatedToPatchRelay: boolean;
  gateCheckStatus: "pending" | "success" | "failure" | "unknown";
  reviewDecision?: string | undefined;
  reviewRequested: boolean;
  currentHeadSha?: string | undefined;
  latestBlockingReviewHeadSha?: string | undefined;
  mergeConflictDetected: boolean;
  reviewQuillAttempt?: ReviewQuillAttemptOwnership | undefined;
}): ClusterCiEntry {
  const {
    issue,
    delegatedToPatchRelay,
    gateCheckStatus,
    reviewDecision,
    reviewRequested,
    currentHeadSha,
    latestBlockingReviewHeadSha,
    mergeConflictDetected,
    reviewQuillAttempt,
  } = params;
  const owner = deriveCiOwner({
    delegatedToPatchRelay,
    gateCheckStatus,
    factoryState: issue.factoryState,
    reviewDecision,
    reviewRequested,
    currentHeadSha,
    latestBlockingReviewHeadSha,
    mergeConflictDetected,
    reviewQuillAttempt,
  });
  return {
    ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
    projectId: issue.projectId,
    prNumber: issue.prNumber!,
    gateStatus: gateCheckStatus,
    owner,
    orphaned: owner === "unknown",
    factoryState: issue.factoryState,
    ...(reviewDecision ? { reviewDecision } : {}),
    message: describeCiOwnership({
      delegatedToPatchRelay,
      gateCheckStatus,
      owner,
      reviewDecision,
      reviewRequested,
      currentHeadSha,
      latestBlockingReviewHeadSha,
      mergeConflictDetected,
      reviewQuillAttempt,
    }),
  };
}

function deriveCiOwner(params: {
  delegatedToPatchRelay: boolean;
  gateCheckStatus: "pending" | "success" | "failure" | "unknown";
  factoryState: string;
  reviewDecision?: string | undefined;
  reviewRequested: boolean;
  currentHeadSha?: string | undefined;
  latestBlockingReviewHeadSha?: string | undefined;
  mergeConflictDetected: boolean;
  reviewQuillAttempt?: ReviewQuillAttemptOwnership | undefined;
}): "patchrelay" | "reviewer" | "review-quill" | "downstream" | "external" | "paused" | "unknown" {
  const headAdvancedPastBlockingReview = Boolean(
    params.currentHeadSha
      && params.latestBlockingReviewHeadSha
      && params.currentHeadSha !== params.latestBlockingReviewHeadSha,
  );
  if (params.gateCheckStatus === "failure") {
    if (!params.delegatedToPatchRelay) return "paused";
    return params.factoryState === "repairing_ci" ? "patchrelay" : "unknown";
  }
  if (params.gateCheckStatus === "pending") {
    return "external";
  }
  if (params.factoryState === "awaiting_queue" || params.reviewDecision === "APPROVED") {
    if (params.mergeConflictDetected && !params.delegatedToPatchRelay) {
      return "paused";
    }
    return params.mergeConflictDetected && params.factoryState !== "repairing_queue"
      ? "unknown"
      : "downstream";
  }
  if (params.reviewDecision === "CHANGES_REQUESTED") {
    if (params.mergeConflictDetected) {
      if (!params.delegatedToPatchRelay) return "paused";
      return params.factoryState === "changes_requested" ? "patchrelay" : "unknown";
    }
    if (!params.delegatedToPatchRelay) return "paused";
    if (params.factoryState === "changes_requested") return "patchrelay";
    if (params.reviewQuillAttempt) return "review-quill";
    if (headAdvancedPastBlockingReview) return "reviewer";
    return "unknown";
  }
  if (params.reviewDecision === "REVIEW_REQUIRED") {
    if (params.reviewQuillAttempt) return "review-quill";
    if (params.gateCheckStatus === "success") return "reviewer";
    return params.reviewRequested ? "reviewer" : "unknown";
  }
  if (params.gateCheckStatus === "success" && params.factoryState === "pr_open") {
    return "reviewer";
  }
  return "external";
}

function describeCiOwnership(params: {
  delegatedToPatchRelay: boolean;
  gateCheckStatus: "pending" | "success" | "failure" | "unknown";
  owner: "patchrelay" | "reviewer" | "review-quill" | "downstream" | "external" | "paused" | "unknown";
  reviewDecision?: string | undefined;
  reviewRequested: boolean;
  currentHeadSha?: string | undefined;
  latestBlockingReviewHeadSha?: string | undefined;
  mergeConflictDetected: boolean;
  reviewQuillAttempt?: ReviewQuillAttemptOwnership | undefined;
}): string {
  const blockingReviewTargetsCurrentHead = Boolean(
    params.currentHeadSha
      && params.latestBlockingReviewHeadSha
      && params.currentHeadSha === params.latestBlockingReviewHeadSha,
  );
  const headAdvancedPastBlockingReview = Boolean(
    params.currentHeadSha
      && params.latestBlockingReviewHeadSha
      && params.currentHeadSha !== params.latestBlockingReviewHeadSha,
  );
  if (params.owner === "patchrelay") {
    if (params.mergeConflictDetected) {
      return "PatchRelay owns the next branch-upkeep move";
    }
    return params.gateCheckStatus === "failure"
      ? "PatchRelay owns the next CI repair move"
      : "PatchRelay owns the next requested-changes move";
  }
  if (params.owner === "review-quill") {
    return params.reviewQuillAttempt
      ? `review-quill attempt #${params.reviewQuillAttempt.id} is ${params.reviewQuillAttempt.status} on the current head`
      : "review-quill owns the current review attempt";
  }
  if (params.owner === "reviewer") {
    if (headAdvancedPastBlockingReview) {
      return "Waiting on review of a newer pushed head";
    }
    return params.reviewRequested
      ? "Waiting on an active reviewer request"
      : "Waiting on review of the current head";
  }
  if (params.owner === "downstream") {
    return params.mergeConflictDetected
      ? "Downstream merge automation is expected to repair or requeue this PR"
      : "Downstream merge automation owns the next move";
  }
  if (params.owner === "external") {
    return params.gateCheckStatus === "pending"
      ? "Waiting on external CI checks to settle"
      : "Waiting on external GitHub automation";
  }
  if (params.owner === "paused") {
    if (params.gateCheckStatus === "failure") {
      return "PatchRelay is paused; delegate the issue again to repair failing CI";
    }
    if (params.reviewDecision === "CHANGES_REQUESTED") {
      return params.mergeConflictDetected
        ? "PatchRelay is paused; delegate the issue again to repair the blocked PR branch"
        : "PatchRelay is paused; delegate the issue again to address requested changes";
    }
    if (params.mergeConflictDetected) {
      return "PatchRelay is paused; delegate the issue again to repair this merge conflict";
    }
    return "PatchRelay is paused; no automatic repair will start until the issue is delegated again";
  }
  if (params.reviewDecision === "CHANGES_REQUESTED") {
    if (params.mergeConflictDetected) {
      return headAdvancedPastBlockingReview
        ? "PR is still dirty after a newer pushed head and no branch-upkeep run is active"
        : "PR is still dirty on the current blocked head and no branch-upkeep run is active";
    }
    return blockingReviewTargetsCurrentHead
      ? "Requested changes still block the same head and no fix run is active"
      : "Waiting on review after a newer pushed head";
  }
  if (params.reviewDecision === "REVIEW_REQUIRED") {
    return "Waiting on review of the current head";
  }
  return "No visible next owner for this PR state";
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

async function collectReviewQuillAttemptOwners(
  snapshots: IssueSnapshot[],
  config: AppConfig,
  runCommand: CommandRunner,
): Promise<Map<string, ReviewQuillAttemptOwnership>> {
  const owners = new Map<string, ReviewQuillAttemptOwnership>();

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
    if (!activeAttempt) continue;

    owners.set(issueKey, {
      id: activeAttempt.id,
      status: activeAttempt.status,
      headSha: activeAttempt.headSha,
    });
  }

  return owners;
}

async function collectActiveOverlapFindings(
  snapshots: IssueSnapshot[],
  runCommand: CommandRunner,
): Promise<ClusterHealthCheck[]> {
  const findings: ClusterHealthCheck[] = [];
  const diffsByProject = new Map<string, ActiveWorktreeDiff[]>();

  for (const snapshot of snapshots) {
    const { issue } = snapshot;
    if (issue.activeRunId === undefined || !issue.worktreePath) {
      continue;
    }
    const files = await listModifiedTrackedFiles(runCommand, issue.worktreePath);
    if (files.size === 0) {
      continue;
    }
    const projectDiffs = diffsByProject.get(issue.projectId) ?? [];
    projectDiffs.push({ issue, files });
    diffsByProject.set(issue.projectId, projectDiffs);
  }

  for (const [projectId, diffs] of diffsByProject) {
    for (let leftIndex = 0; leftIndex < diffs.length; leftIndex += 1) {
      const left = diffs[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < diffs.length; rightIndex += 1) {
        const right = diffs[rightIndex]!;
        const overlap = [...left.files].filter((file) => right.files.has(file)).sort();
        if (overlap.length === 0) {
          continue;
        }
        findings.push({
          status: "warn",
          scope: "issue:overlap",
          message: `Active work overlaps with ${right.issue.issueKey ?? right.issue.linearIssueId}: ${overlap.slice(0, 3).join(", ")}${overlap.length > 3 ? " ..." : ""}`,
          ...(left.issue.issueKey ? { issueKey: left.issue.issueKey } : {}),
          projectId,
        });
      }
    }
  }

  return findings;
}

async function listModifiedTrackedFiles(
  runCommand: CommandRunner,
  worktreePath: string,
): Promise<Set<string>> {
  let result: CommandRunnerResult;
  try {
    result = await runCommand("git", ["-C", worktreePath, "status", "--porcelain", "--untracked-files=no"]);
  } catch {
    return new Set();
  }
  if (result.exitCode !== 0) {
    return new Set();
  }

  const files = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    const normalized = rawPath.includes(" -> ")
      ? rawPath.split(" -> ").at(-1)?.trim()
      : rawPath;
    if (normalized) {
      files.add(normalized);
    }
  }
  return files;
}

function getGateCheckNames(project: AppConfig["projects"][number] | undefined): string[] {
  const configured = project?.gateChecks?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  return configured.length > 0 ? configured : ["verify"];
}

function deriveCiGateStatus(
  statusCheckRollup: GitHubStatusRollupEntry[] | undefined,
  gateCheckNames: string[],
): "pending" | "success" | "failure" | "unknown" {
  const gateStatus = deriveGateCheckStatusFromRollup(statusCheckRollup, gateCheckNames);
  if (gateStatus) {
    return gateStatus;
  }

  const entries = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  if (entries.length === 0) {
    return "unknown";
  }

  const hasPending = entries.some((entry) => {
    const status = entry.status?.trim().toLowerCase();
    return status === "queued" || status === "in_progress" || status === "requested" || status === "waiting" || status === "pending";
  });
  if (hasPending) {
    return "pending";
  }

  return "unknown";
}

async function probeReviewQuillAttempts(
  runCommand: CommandRunner,
  repoFullName: string,
  prNumber: number,
): Promise<
  | {
      ok: true;
      currentHeadSha?: string | undefined;
      attempts: Array<{ id: number; headSha: string; status: "queued" | "running"; stale: boolean }>;
    }
  | { ok: false; error: string }
> {
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

  const attempts = parsedAttempts.attempts.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    const headSha = (entry as { headSha?: unknown }).headSha;
    const status = (entry as { status?: unknown }).status;
    const stale = (entry as { stale?: unknown }).stale;
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
    attempts,
  };
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
    healthy: (payload: JsonObject) => boolean;
    summarize: (payload: JsonObject) => string;
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
      "state,reviewDecision,reviewRequests,latestReviews,statusCheckRollup,mergeable,mergeStateStatus,headRefOid",
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

function extractLatestBlockingReviewHeadSha(latestReviews: unknown[] | undefined): string | undefined {
  if (!Array.isArray(latestReviews)) {
    return undefined;
  }
  for (const review of latestReviews) {
    if (!review || typeof review !== "object") continue;
    const state = typeof (review as { state?: unknown }).state === "string"
      ? String((review as { state: string }).state).trim().toUpperCase()
      : undefined;
    if (state !== "CHANGES_REQUESTED") continue;
    const commitOid = typeof (review as { commit?: { oid?: unknown } }).commit?.oid === "string"
      ? String((review as { commit: { oid: string } }).commit.oid).trim()
      : undefined;
    if (commitOid) return commitOid;
  }
  return undefined;
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

function safeJsonParse(value: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}
