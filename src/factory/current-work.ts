import type { ProjectConfig } from "../types.ts";
import { buildFactoryProjects, type FactoryIssue, type QueueObservation, type ReviewObservation } from "./model.ts";
import { RECENT_WORK_MS, type FactoryRepositoryPrs } from "./github.ts";
import type { FactoryTask } from "./types.ts";

export function buildCurrentFactoryProjects(
  configs: Pick<ProjectConfig, "id" | "github">[], issues: FactoryIssue[],
  queues: QueueObservation[], reviews: ReviewObservation[], repositories: FactoryRepositoryPrs[], now = Date.now(),
) {
  const cutoff = now - RECENT_WORK_MS;
  const prs = new Map(repositories.filter(r => r.available).flatMap(r => r.prs
    .filter(pr => pr.state === "open" || (pr.merged_at && Date.parse(pr.merged_at) >= cutoff))
    .map(pr => [`${r.repo}#${pr.number}`, { ...pr, repo: r.repo }] as const)));
  const projectRepos = new Map(configs.map(c => [c.id, c.github?.repoFullName]));
  const currentIssues = issues.flatMap(issue => {
    if (issue.prNumber === undefined) return issue.phase !== "done" && (issue.activeRunType || Date.parse(issue.updatedAt) >= cutoff) ? [issue] : [];
    const pr = prs.get(`${projectRepos.get(issue.projectId)}#${issue.prNumber}`);
    if (!pr) return [];
    const sameHead = pr.head.sha === issue.prHeadSha;
    const current: FactoryIssue = { ...issue, prState: pr.merged_at ? "merged" : "open", prHeadSha: pr.head.sha };
    if (!sameHead) {
      current.phase = "pr_open";
      delete current.prReviewState;
      delete current.prChecksSummary;
      delete current.statusNote;
      delete current.waitingReason;
    }
    return [current];
  });
  const matches = (entry: QueueObservation | ReviewObservation) => {
    const pr = prs.get(`${entry.repo}#${entry.prNumber}`);
    return pr?.state === "open" && entry.headSha === pr.head.sha;
  };
  const projects = buildFactoryProjects(configs, currentIssues, queues.filter(matches), reviews.filter(matches));
  for (const pr of prs.values()) {
    let project = projects.find(p => p.repo === pr.repo);
    if (!project) {
      project = { id: `github:${pr.repo}`, name: pr.repo, repo: pr.repo, tasks: [] };
      projects.push(project);
    }
    let task = project.tasks.find(t => t.prNumber === pr.number);
    if (!task) {
      task = { id: `${project.id}:pr-${pr.number}`, projectId: project.id, key: `#${pr.number}`, title: pr.title,
        station: "review", signal: "waiting", phase: pr.draft ? "Draft PR" : "Open PR", paused: false, repairing: false,
        updatedAt: pr.updated_at, prNumber: pr.number, prUrl: `https://github.com/${pr.repo}/pull/${pr.number}`, headSha: pr.head.sha } satisfies FactoryTask;
      project.tasks.push(task);
    }
    const prUpdatedAt = pr.merged_at ?? pr.updated_at;
    if (Date.parse(prUpdatedAt) > Date.parse(task.updatedAt)) task.updatedAt = prUpdatedAt;
    if (!task.issueKey) task.title = pr.title;
    if (pr.merged_at) {
      task.station = "main";
      task.signal = task.phase === "failed" || task.phase === "escalated" ? "attention" : "complete";
      task.repairing = false;
      delete task.queue;
    }
  }
  return projects.sort((a, b) => a.id.localeCompare(b.id));
}
