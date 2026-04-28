import { Buffer } from "node:buffer";
import type {
  CheckRunRecord,
  PullRequestFile,
  PullRequestReviewCommentRecord,
  PullRequestReviewRecord,
  PullRequestSummary,
} from "./types.ts";

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
// - GET/HEAD: 5 total attempts for retryable failures (the initial call counts as attempt #1).
// - Other methods: 3 total attempts for network errors before a response.
// - Exponential backoff: 250ms → 1000ms → 4000ms → 16000ms, ±20% jitter.
// - Cap any single delay at 30s even if `Retry-After` asks for more.
// - GET/HEAD (idempotent) retry on network errors, 5xx, and 429.
// - POST/PUT/PATCH/DELETE (non-idempotent) retry ONLY on network errors —
//   blind retry on 5xx risks double-creation on reviews/check-runs.
const HTTP_IDEMPOTENT_RETRY_MAX_ATTEMPTS = 5;
const HTTP_NON_IDEMPOTENT_NETWORK_RETRY_MAX_ATTEMPTS = 3;
const HTTP_RETRY_BASE_DELAY_MS = 250;
const HTTP_RETRY_MAX_DELAY_MS = 30_000;
const HTTP_RETRY_JITTER_RATIO = 0.2;
const HTTP_ERROR_BODY_PREVIEW_CHARS = 800;

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

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, raw: string) => {
    const named: Record<string, string> = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      middot: "·",
      nbsp: " ",
      quot: "\"",
    };
    const lower = raw.toLowerCase();
    if (lower in named) return named[lower]!;
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    }
    return entity;
  });
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateForError(value: string): string {
  if (value.length <= HTTP_ERROR_BODY_PREVIEW_CHARS) return value;
  return `${value.slice(0, HTTP_ERROR_BODY_PREVIEW_CHARS)}…`;
}

function summarizeHtmlError(body: string): string {
  const text = decodeHtmlEntities(body)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return truncateForError(compactWhitespace(text) || "HTML response");
}

function summarizeJsonError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof record.message === "string" && record.message.trim()) {
      parts.push(record.message.trim());
    }
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      parts.push(record.errors.map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const message = (entry as Record<string, unknown>).message;
          if (typeof message === "string") return message;
        }
        return JSON.stringify(entry);
      }).join("; "));
    }
    if (typeof record.documentation_url === "string" && record.documentation_url.trim()) {
      parts.push(`docs: ${record.documentation_url.trim()}`);
    }
    return truncateForError(parts.length > 0 ? parts.join(" | ") : JSON.stringify(parsed));
  } catch {
    return undefined;
  }
}

function summarizeErrorBody(body: string, contentType: string | null): string {
  const trimmed = body.trim();
  if (!trimmed) return "empty response body";
  if (contentType?.toLowerCase().includes("json")) {
    return summarizeJsonError(trimmed) ?? truncateForError(compactWhitespace(trimmed));
  }
  if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(trimmed) || contentType?.toLowerCase().includes("html")) {
    return `HTML response: ${summarizeHtmlError(trimmed)}`;
  }
  return truncateForError(compactWhitespace(trimmed));
}

function normalizePullRequestState(pr: Record<string, unknown>): PullRequestSummary["state"] {
  if (typeof pr.merged_at === "string" && pr.merged_at.trim()) return "MERGED";
  const state = String(pr.state ?? "OPEN").toUpperCase();
  return state;
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
    const maxAttempts = isIdempotentMethod(method)
      ? HTTP_IDEMPOTENT_RETRY_MAX_ATTEMPTS
      : HTTP_NON_IDEMPOTENT_NETWORK_RETRY_MAX_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
        if (attempt >= maxAttempts) throw lastError;
        await sleep(exponentialBackoffMs(attempt));
        continue;
      }

      if (response.ok) {
        return await response.json() as T;
      }

      // Non-ok HTTP response. Read the body once (the body stream is
      // single-use) and decide whether to retry.
      const body = await response.text();
      const bodySummary = summarizeErrorBody(body, response.headers.get("content-type"));
      const httpError = new Error(`GitHub API ${response.status} for ${path}: ${bodySummary}`);
      lastError = httpError;

      const retryable = isRetryableStatus(response.status) && isIdempotentMethod(method);
      if (!retryable || attempt >= maxAttempts) {
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
    throw lastError ?? new Error(`GitHub API request to ${path} failed after ${maxAttempts} attempts`);
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
      state: normalizePullRequestState(pr),
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
      state: normalizePullRequestState(pr),
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

  async listPullRequestReviewComments(repoFullName: string, prNumber: number): Promise<PullRequestReviewCommentRecord[]> {
    const encodedRepo = repoFullName.split("/").map(encodeURIComponent).join("/");
    const comments = await this.request<Array<Record<string, unknown>>>(
      repoFullName,
      `/repos/${encodedRepo}/pulls/${prNumber}/comments?per_page=100`,
    );
    return comments.map((comment) => ({
      id: Number(comment.id),
      ...(comment.pull_request_review_id !== null && comment.pull_request_review_id !== undefined
        ? { reviewId: Number(comment.pull_request_review_id) }
        : {}),
      ...(typeof comment.body === "string" ? { body: comment.body } : {}),
      ...(typeof comment.path === "string" ? { path: comment.path } : {}),
      ...(typeof comment.line === "number" ? { line: comment.line } : {}),
      ...(typeof comment.commit_id === "string" ? { commitId: comment.commit_id } : {}),
      ...(typeof (comment.user as Record<string, unknown> | undefined)?.login === "string"
        ? { authorLogin: String((comment.user as Record<string, unknown>).login) }
        : {}),
      ...(typeof comment.created_at === "string" ? { createdAt: comment.created_at } : {}),
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
      ...(typeof (check.output as Record<string, unknown> | undefined)?.title === "string"
        ? { outputTitle: String((check.output as Record<string, unknown>).title) }
        : {}),
      ...(typeof (check.output as Record<string, unknown> | undefined)?.summary === "string"
        ? { outputSummary: String((check.output as Record<string, unknown>).summary) }
        : {}),
      ...(typeof (check.output as Record<string, unknown> | undefined)?.text === "string"
        ? { outputText: String((check.output as Record<string, unknown>).text) }
        : {}),
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
