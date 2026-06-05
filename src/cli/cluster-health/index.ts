import type { PatchRelayDatabase } from "../../db.ts";
import { hasOpenPr } from "../../pr-state.ts";
import type { AppConfig } from "../../types.ts";
import type { CommandRunner } from "../command-types.ts";
import { collectActiveOverlapFindings } from "./active-overlap.ts";
import {
  evaluateLocalIssueHealth,
  evaluateTerminalIssueHealth,
  isActiveWorkflowIssue,
  isTerminalFailureIssue,
  isResolvedDependency,
  needsReviewAutomation,
} from "./local-issue-health.ts";
import { evaluateGitHubIssueHealth } from "./github-issue-health.ts";
import {
  type ReviewQuillStatusJson,
  collectReviewQuillAttemptOwners,
} from "./review-quill-probe.ts";
import {
  probeOptionalService,
  probePatchRelayService,
} from "./service-probe.ts";
import { type JsonObject } from "./shared.ts";
import type {
  ClusterCiEntry,
  ClusterHealthCheck,
  ClusterHealthReport,
  ClusterHealthSummary,
  IssueSnapshot,
  ReviewQuillAttemptOwnership,
} from "./types.ts";

export type {
  ClusterCiEntry,
  ClusterHealthCheck,
  ClusterHealthReport,
  ClusterHealthSummary,
} from "./types.ts";

interface MergeStewardStatusJson extends JsonObject {
  health?: { reachable?: boolean; ok?: boolean } | undefined;
  systemd?: { ActiveState?: string } | undefined;
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
  const activeWorkflowIssues = issues.filter((issue) => isActiveWorkflowIssue(issue));
  const historicalTerminalIssues = issues.filter((issue) => isTerminalFailureIssue(issue));
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

  const snapshots: IssueSnapshot[] = activeWorkflowIssues.map((issue) => {
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

  const reviewQuillAttemptOwners: Map<string, ReviewQuillAttemptOwnership> = reviewQuillProbe?.status === "pass"
    ? await collectReviewQuillAttemptOwners(reviewRelevantIssues, config, runCommand)
    : new Map();

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

  for (const issue of historicalTerminalIssues) {
    const finding = evaluateTerminalIssueHealth(issue);
    if (finding) {
      checks.push({
        ...finding,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        projectId: issue.projectId,
        ...(issue.prNumber !== undefined ? { prNumber: issue.prNumber } : {}),
      });
    }
  }

  checks.push(...await collectActiveOverlapFindings(snapshots, runCommand));

  for (const snapshot of snapshots) {
    if (!hasOpenPr(snapshot.issue.prNumber, snapshot.issue.prState)) {
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
  if (workflowFailures.every((check) => check.status === "pass" || check.status === "warn") && activeWorkflowIssues.length > 0) {
    checks.push({
      status: "pass",
      scope: "workflow",
      message: `All ${activeWorkflowIssues.length} active workflow issues currently have active work, a tracked blocker, or a downstream owner`,
    });
  }
  if (activeWorkflowIssues.length === 0) {
    checks.push({
      status: "pass",
      scope: "workflow",
      message: "No active workflow issues are currently tracked",
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
    openIssues: activeWorkflowIssues.length,
    activeRuns: activeWorkflowIssues.filter((issue) => issue.activeRunId !== undefined).length,
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
