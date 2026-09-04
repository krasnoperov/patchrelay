import type { PatchRelayService } from "../service.ts";
import type { ProjectConfig } from "../types.ts";
import type { FactoryProject, FactoryTask, Station } from "./types.ts";

export type FactoryIssue = ReturnType<
  PatchRelayService["listTrackedIssues"]
>[number];
export interface QueueObservation {
  repo: string;
  prNumber: number;
  headSha: string;
  status: string;
  position: number;
  priority?: number;
  updatedAt: string;
  title?: string | undefined;
}
export interface ReviewObservation {
  repo: string;
  prNumber: number;
  headSha: string;
  status: string;
  conclusion?: string | undefined;
  updatedAt: string;
}

const repairPhases = new Set([
  "changes_requested",
  "repairing_ci",
  "repairing_queue",
]);
const activeQueueStates = new Set([
  "queued",
  "preparing_head",
  "validating",
  "merging",
]);

function stationFor(issue: FactoryIssue): Station {
  // A workflow can finish without a PR. Never call that a merge.
  if (issue.prState === "merged") return "main";
  if (repairPhases.has(issue.phase) || issue.phase === "implementing")
    return "implementation";
  if (issue.phase === "awaiting_queue") return "queue";
  if (issue.prNumber !== undefined && issue.prState !== "closed")
    return "review";
  return "intake";
}

export function buildFactoryProjects(
  configs: Pick<ProjectConfig, "id" | "github">[],
  issues: FactoryIssue[],
  queues: QueueObservation[] = [],
  reviews: ReviewObservation[] = [],
): FactoryProject[] {
  // position is a lifetime admission counter. Pick the latest admission per PR,
  // then rank active entries in the same priority/position order as the steward.
  const latestQueues = new Map<string, QueueObservation>();
  for (const queue of [...queues].sort((a, b) => a.position - b.position || a.updatedAt.localeCompare(b.updatedAt))) {
    latestQueues.set(`${queue.repo}#${queue.prNumber}`, queue);
  }
  const queueRanks = new Map<QueueObservation, number>();
  const repoRanks = new Map<string, number>();
  for (const queue of [...latestQueues.values()].filter((q) => activeQueueStates.has(q.status))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.position - b.position)) {
    const rank = (repoRanks.get(queue.repo) ?? 0) + 1;
    repoRanks.set(queue.repo, rank);
    queueRanks.set(queue, rank);
  }
  const projects = new Map<string, FactoryProject>(
    configs.map((config) => [
      config.id,
      {
        id: config.id,
        name: config.id,
        ...(config.github?.repoFullName
          ? { repo: config.github.repoFullName }
          : {}),
        tasks: [],
      },
    ]),
  );
  for (const issue of issues) {
    const project = projects.get(issue.projectId) ?? {
      id: issue.projectId,
      name: issue.projectId,
      tasks: [],
    };
    projects.set(project.id, project);
    const station = stationFor(issue);
    const repairing = repairPhases.has(issue.phase) && station !== "main";
    const paused =
      issue.delegatedToPatchRelay === false || issue.phase === "paused";
    const task: FactoryTask = {
      id: `${project.id}:${issue.issueKey ?? `pr-${issue.prNumber ?? issue.updatedAt}`}`,
      projectId: project.id,
      key:
        issue.issueKey ??
        (issue.prNumber !== undefined ? `#${issue.prNumber}` : "Unkeyed issue"),
      title: issue.title ?? "Untitled issue",
      station,
      phase: issue.phase,
      signal:
        ["failed", "escalated", "awaiting_input"].includes(issue.phase) ||
        repairing ||
        issue.blockedByCount > 0
          ? "attention"
          : issue.activeRunType && !paused
            ? "active"
            : issue.phase === "done" || station === "main"
              ? "complete"
              : "waiting",
      updatedAt: issue.updatedAt,
      paused,
      repairing,
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      ...(issue.prNumber !== undefined ? { prNumber: issue.prNumber } : {}),
      ...(project.repo && issue.prNumber !== undefined
        ? { prUrl: `https://github.com/${project.repo}/pull/${issue.prNumber}` }
        : {}),
      ...(issue.prHeadSha ? { headSha: issue.prHeadSha } : {}),
      ...(issue.activeRunType ? { agent: issue.activeRunType } : {}),
      ...(issue.prReviewState ? { review: issue.prReviewState } : {}),
      ...(issue.prChecksSummary ? { checks: issue.prChecksSummary } : {}),
      ...((issue.statusNote ?? issue.waitingReason)
        ? { note: issue.statusNote ?? issue.waitingReason }
        : {}),
    };
    // External observations remain separate from PatchRelay's native phase.
    // Only a matching head can supply current review or queue state.
    const review = reviews
      .filter(
        (r) =>
          r.repo === project.repo &&
          r.prNumber === task.prNumber &&
          r.headSha === task.headSha,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (review) applyReview(task, review);
    const queue = latestQueues.get(`${project.repo}#${task.prNumber}`);
    if (queue && queue.headSha === task.headSha) applyQueue(task, queue, queueRanks.get(queue));
    project.tasks.push(task);
  }
  // Queue-only PRs also belong in the world, including repos with no Linear issues.
  for (const queue of latestQueues.values()) {
    let project = [...projects.values()].find((p) => p.repo === queue.repo);
    if (!project) {
      project = {
        id: `github:${queue.repo}`,
        name: queue.repo.split("/").at(-1) ?? queue.repo,
        repo: queue.repo,
        tasks: [],
      };
      projects.set(project.id, project);
    }
    if (project.tasks.some((task) => task.prNumber === queue.prNumber))
      continue;
    const task: FactoryTask = {
      id: `${project.id}:pr-${queue.prNumber}`,
      projectId: project.id,
      key: `#${queue.prNumber}`,
      title: queue.title ?? `Pull request #${queue.prNumber}`,
      station: "queue",
      signal: "waiting",
      phase: "External PR",
      paused: false,
      repairing: false,
      updatedAt: queue.updatedAt,
      prNumber: queue.prNumber,
      prUrl: `https://github.com/${queue.repo}/pull/${queue.prNumber}`,
      headSha: queue.headSha,
    };
    applyQueue(task, queue, queueRanks.get(queue));
    project.tasks.push(task);
  }
  const latestReviews = new Map<string, ReviewObservation>();
  for (const review of [...reviews].sort((a, b) =>
    a.updatedAt.localeCompare(b.updatedAt),
  )) {
    if (review.status === "cancelled" || review.status === "superseded")
      continue;
    latestReviews.set(`${review.repo}#${review.prNumber}`, review);
  }
  for (const review of latestReviews.values()) {
    let project = [...projects.values()].find((p) => p.repo === review.repo);
    if (!project) {
      project = {
        id: `github:${review.repo}`,
        name: review.repo.split("/").at(-1) ?? review.repo,
        repo: review.repo,
        tasks: [],
      };
      projects.set(project.id, project);
    }
    // Existing queue or issue records determine placement when available.
    const existing = project.tasks.find(
      (task) => task.prNumber === review.prNumber,
    );
    if (existing) {
      if (existing.headSha === review.headSha) applyReview(existing, review);
      continue;
    }
    const task: FactoryTask = {
      id: `${project.id}:pr-${review.prNumber}`,
      projectId: project.id,
      key: `#${review.prNumber}`,
      title: `Pull request #${review.prNumber}`,
      station: "review",
      phase: "External review",
      signal: "waiting",
      updatedAt: review.updatedAt,
      paused: false,
      repairing: false,
      prNumber: review.prNumber,
      prUrl: `https://github.com/${review.repo}/pull/${review.prNumber}`,
      headSha: review.headSha,
      review: review.conclusion ?? review.status,
      note: "Latest review-quill observation. PR lifecycle has not been observed by PatchRelay or merge-steward.",
    };
    applyReview(task, review);
    project.tasks.push(task);
  }
  return [...projects.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function applyReview(task: FactoryTask, review: ReviewObservation) {
  task.review = review.conclusion ?? review.status;
  if (task.station === "main") return;
  if (review.status === "failed" || review.conclusion === "declined" || review.conclusion === "error") {
    task.signal = "attention";
  } else if (review.status === "running" && task.station === "review" && task.signal === "waiting" && !task.paused) {
    task.signal = "active";
  }
}

function applyQueue(task: FactoryTask, queue: QueueObservation, rank?: number) {
  task.queue = {
    status: queue.status,
    ...(rank !== undefined ? { position: rank } : {}),
    headSha: queue.headSha,
  };
  if (queue.status === "merged") {
    task.station = "main";
    task.signal =
      task.phase === "failed" || task.phase === "escalated"
        ? "attention"
        : "complete";
    task.repairing = false;
  } else if (
    task.station !== "main" &&
    !task.repairing &&
    activeQueueStates.has(queue.status)
  ) {
    task.station = "queue";
    if (task.signal !== "attention")
      task.signal = queue.status === "queued" ? "waiting" : "active";
  } else if (
    task.station !== "main" &&
    (queue.status === "evicted" || queue.status === "dequeued")
  ) {
    task.signal = "attention";
    task.note ??= `Merge queue ${queue.status}. Open the PR to inspect the next action.`;
  }
}
