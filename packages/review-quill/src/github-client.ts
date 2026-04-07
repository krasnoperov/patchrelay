import { Buffer } from "node:buffer";
import type { CheckRunRecord, PullRequestFile, PullRequestReviewRecord, PullRequestSummary } from "./types.ts";

export interface GitHubClientAuthProvider {
  currentTokenForRepo(repoFullName?: string): string | undefined;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export class GitHubClient {
  constructor(private readonly auth: GitHubClientAuthProvider) {}

  private async request<T>(repoFullName: string, path: string, init: RequestInit = {}): Promise<T> {
    const token = this.auth.currentTokenForRepo(repoFullName);
    if (!token) throw new Error(`No GitHub installation token available for ${repoFullName}`);

    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        ...githubHeaders(token),
        ...(init.headers ? init.headers as Record<string, string> : {}),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API ${response.status} for ${path}: ${body}`);
    }
    return await response.json() as T;
  }

  async listOpenPullRequests(repoFullName: string): Promise<PullRequestSummary[]> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    const prs = await this.request<Array<Record<string, unknown>>>(
      repoFullName,
      `/repos/${encodedRepo}/pulls?state=open&per_page=100`,
    );
    return prs.map((pr) => ({
      number: Number(pr.number),
      title: String(pr.title ?? ""),
      ...(typeof pr.body === "string" ? { body: pr.body } : {}),
      url: String(pr.html_url ?? ""),
      state: String(pr.state ?? "OPEN"),
      isDraft: Boolean(pr.draft),
      headSha: String((pr.head as Record<string, unknown> | undefined)?.sha ?? ""),
      headRefName: String((pr.head as Record<string, unknown> | undefined)?.ref ?? ""),
      baseRefName: String((pr.base as Record<string, unknown> | undefined)?.ref ?? ""),
      ...(typeof (pr.user as Record<string, unknown> | undefined)?.login === "string"
        ? { authorLogin: String((pr.user as Record<string, unknown>).login) }
        : {}),
    }));
  }

  async listPullRequestFiles(repoFullName: string, prNumber: number): Promise<PullRequestFile[]> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    const files = await this.request<Array<Record<string, unknown>>>(
      repoFullName,
      `/repos/${encodedRepo}/pulls/${prNumber}/files?per_page=100`,
    );
    return files.map((file) => ({
      filename: String(file.filename ?? ""),
      status: String(file.status ?? ""),
      additions: Number(file.additions ?? 0),
      deletions: Number(file.deletions ?? 0),
      changes: Number(file.changes ?? 0),
      ...(typeof file.patch === "string" ? { patch: file.patch } : {}),
    }));
  }

  async listPullRequestReviews(repoFullName: string, prNumber: number): Promise<PullRequestReviewRecord[]> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    const reviews = await this.request<Array<Record<string, unknown>>>(
      repoFullName,
      `/repos/${encodedRepo}/pulls/${prNumber}/reviews?per_page=100`,
    );
    return reviews.map((review) => ({
      id: Number(review.id),
      ...(typeof review.state === "string" ? { state: review.state } : {}),
      ...(typeof review.body === "string" ? { body: review.body } : {}),
      ...(typeof (review.user as Record<string, unknown> | undefined)?.login === "string"
        ? { authorLogin: String((review.user as Record<string, unknown>).login) }
        : {}),
      ...(typeof review.submitted_at === "string" ? { submittedAt: review.submitted_at } : {}),
      ...(typeof review.commit_id === "string" ? { commitId: review.commit_id } : {}),
    }));
  }

  async listCheckRuns(repoFullName: string, headSha: string): Promise<CheckRunRecord[]> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    const payload = await this.request<{ check_runs: Array<Record<string, unknown>> }>(
      repoFullName,
      `/repos/${encodedRepo}/commits/${headSha}/check-runs?per_page=100`,
    );
    return payload.check_runs.map((check) => ({
      id: Number(check.id),
      name: String(check.name ?? ""),
      status: String(check.status ?? ""),
      ...(typeof check.conclusion === "string" ? { conclusion: check.conclusion } : {}),
      ...(typeof check.details_url === "string" ? { detailsUrl: check.details_url } : {}),
    }));
  }

  async readRepoFile(repoFullName: string, filePath: string, ref: string): Promise<string | undefined> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    try {
      const payload = await this.request<Record<string, unknown>>(
        repoFullName,
        `/repos/${encodedRepo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      );
      if (payload.type !== "file" || typeof payload.content !== "string") return undefined;
      return Buffer.from(String(payload.content).replace(/\n/g, ""), "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }

  async createCheckRun(repoFullName: string, params: {
    name: string;
    headSha: string;
    status: "queued" | "in_progress" | "completed";
    conclusion?: "success" | "failure" | "neutral" | "cancelled";
    detailsUrl?: string;
    summary?: string;
    title?: string;
    text?: string;
  }): Promise<number> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    const payload = await this.request<Record<string, unknown>>(
      repoFullName,
      `/repos/${encodedRepo}/check-runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: params.name,
          head_sha: params.headSha,
          status: params.status,
          ...(params.conclusion ? { conclusion: params.conclusion } : {}),
          ...(params.detailsUrl ? { details_url: params.detailsUrl } : {}),
          output: {
            title: params.title ?? "Review Quill",
            summary: params.summary ?? "",
            text: params.text ?? "",
          },
        }),
      },
    );
    return Number(payload.id);
  }

  async updateCheckRun(repoFullName: string, checkRunId: number, params: {
    status: "queued" | "in_progress" | "completed";
    conclusion?: "success" | "failure" | "neutral" | "cancelled";
    detailsUrl?: string;
    summary?: string;
    title?: string;
    text?: string;
  }): Promise<void> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    await this.request(
      repoFullName,
      `/repos/${encodedRepo}/check-runs/${checkRunId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: params.status,
          ...(params.conclusion ? { conclusion: params.conclusion } : {}),
          ...(params.detailsUrl ? { details_url: params.detailsUrl } : {}),
          output: {
            title: params.title ?? "Review Quill",
            summary: params.summary ?? "",
            text: params.text ?? "",
          },
          ...(params.status === "completed" ? { completed_at: new Date().toISOString() } : {}),
        }),
      },
    );
  }

  async submitReview(repoFullName: string, prNumber: number, params: {
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body: string;
  }): Promise<void> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    await this.request(
      repoFullName,
      `/repos/${encodedRepo}/pulls/${prNumber}/reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: params.event,
          body: params.body,
        }),
      },
    );
  }
}
