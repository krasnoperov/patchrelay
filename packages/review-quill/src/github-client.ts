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

// Retry policy for transient failures on the GitHub API.
// - 3 total attempts (the initial call counts as attempt #1).
// - Exponential backoff: 250ms → 1000ms → 4000ms, ±20% jitter.
// - Cap any single delay at 30s even if `Retry-After` asks for more.
// - GET/HEAD (idempotent) retry on network errors, 5xx, and 429.
// - POST/PUT/PATCH/DELETE (non-idempotent) retry ONLY on network errors —
//   blind retry on 5xx risks double-creation on reviews/check-runs.
const HTTP_RETRY_MAX_ATTEMPTS = 3;
const HTTP_RETRY_BASE_DELAY_MS = 250;
const HTTP_RETRY_MAX_DELAY_MS = 30_000;
const HTTP_RETRY_JITTER_RATIO = 0.2;

function isIdempotentMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

// Parse a Retry-After header that can be either delay-seconds or an HTTP date.
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value.trim());
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.min(Math.round(numeric * 1000), HTTP_RETRY_MAX_DELAY_MS);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(0, date - Date.now()), HTTP_RETRY_MAX_DELAY_MS);
  }
  return undefined;
}

function exponentialBackoffMs(attempt: number): number {
  // attempt=1 → 250ms, attempt=2 → 1000ms, attempt=3 → 4000ms
  const base = HTTP_RETRY_BASE_DELAY_MS * Math.pow(4, attempt - 1);
  const capped = Math.min(base, HTTP_RETRY_MAX_DELAY_MS);
  const jitter = capped * HTTP_RETRY_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class GitHubClient {
  constructor(private readonly auth: GitHubClientAuthProvider) {}

  currentTokenForRepo(repoFullName?: string): string | undefined {
    return this.auth.currentTokenForRepo(repoFullName);
  }

  private async request<T>(repoFullName: string, path: string, init: RequestInit = {}): Promise<T> {
    const token = this.currentTokenForRepo(repoFullName);
    if (!token) throw new Error(`No GitHub installation token available for ${repoFullName}`);

    const method = (init.method ?? "GET").toUpperCase();
    const url = `https://api.github.com${path}`;
    const fetchInit: RequestInit = {
      ...init,
      method,
      headers: {
        ...githubHeaders(token),
        ...(init.headers ? init.headers as Record<string, string> : {}),
      },
    };

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= HTTP_RETRY_MAX_ATTEMPTS; attempt += 1) {
      // Try the request.
      let response: Response;
      try {
        response = await fetch(url, fetchInit);
      } catch (error) {
        // Network error BEFORE the server saw a response. Safe to retry
        // even non-idempotent methods here because the server never
        // processed anything. Exponential backoff (no Retry-After
        // information available on a network error).
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= HTTP_RETRY_MAX_ATTEMPTS) throw lastError;
        await sleep(exponentialBackoffMs(attempt));
        continue;
      }

      if (response.ok) {
        return await response.json() as T;
      }

      // Non-ok HTTP response. Read the body once (the body stream is
      // single-use) and decide whether to retry.
      const body = await response.text();
      const httpError = new Error(`GitHub API ${response.status} for ${path}: ${body}`);
      lastError = httpError;

      const retryable = isRetryableStatus(response.status) && isIdempotentMethod(method);
      if (!retryable || attempt >= HTTP_RETRY_MAX_ATTEMPTS) {
        throw httpError;
      }

      // Honor Retry-After when the server supplies one (429/503 usually do);
      // fall back to exponential backoff otherwise. Either way this is the
      // ONLY sleep for this iteration — no top-of-loop sleep compounds it.
      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      const waitMs = retryAfterMs ?? exponentialBackoffMs(attempt);
      await sleep(Math.min(waitMs, HTTP_RETRY_MAX_DELAY_MS));
    }

    // Unreachable in practice — the loop body either returns on success
    // or throws on the final failure. Defensive rethrow to keep TypeScript
    // inference happy.
    throw lastError ?? new Error(`GitHub API request to ${path} failed after ${HTTP_RETRY_MAX_ATTEMPTS} attempts`);
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
      ...(typeof pr.merged_at === "string" ? { mergedAt: pr.merged_at } : {}),
      ...(typeof pr.closed_at === "string" ? { closedAt: pr.closed_at } : {}),
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

  async getPullRequest(repoFullName: string, prNumber: number): Promise<PullRequestSummary> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    const pr = await this.request<Record<string, unknown>>(
      repoFullName,
      `/repos/${encodedRepo}/pulls/${prNumber}`,
    );
    return {
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
      ...(typeof pr.merged_at === "string" ? { mergedAt: pr.merged_at } : {}),
      ...(typeof pr.closed_at === "string" ? { closedAt: pr.closed_at } : {}),
    };
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
    commitId?: string;
    comments?: Array<{
      path: string;
      line: number;
      side?: "LEFT" | "RIGHT";
      body: string;
    }>;
  }): Promise<void> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    const payload: Record<string, unknown> = {
      event: params.event,
      body: params.body,
    };
    if (params.commitId) {
      payload.commit_id = params.commitId;
    }
    if (params.comments && params.comments.length > 0) {
      payload.comments = params.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side ?? "RIGHT",
        body: c.body,
      }));
    }
    await this.request(
      repoFullName,
      `/repos/${encodedRepo}/pulls/${prNumber}/reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  async dismissReview(repoFullName: string, prNumber: number, reviewId: number, message: string): Promise<void> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    await this.request(
      repoFullName,
      `/repos/${encodedRepo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      },
    );
  }
}
