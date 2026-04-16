import type { ResolveCommandRunner } from "../resolve.ts";

export interface PrGitHubCheck {
  name: string;
  status: "success" | "failure" | "pending";
  required: boolean;
  detailsUrl?: string;
}

export type PrGitHubState = "OPEN" | "CLOSED" | "MERGED";
export type PrGitHubReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | "COMMENTED"
  | "";

export interface PrGitHubOverview {
  number: number;
  branch: string;
  headSha: string;
  state: PrGitHubState;
  merged: boolean;
  reviewDecision: PrGitHubReviewDecision;
  mergeStateStatus?: string;
  labels: string[];
  checks: PrGitHubCheck[];
}

interface RawRollupNode {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string | null;
  state?: string | null;
  conclusion?: string | null;
  isRequired?: boolean;
  detailsUrl?: string;
  targetUrl?: string;
}

interface RawPrView {
  number: number;
  headRefName: string;
  headRefOid: string;
  state: string;
  reviewDecision?: string;
  mergeStateStatus?: string;
  labels?: Array<{ name: string }>;
  statusCheckRollup?: RawRollupNode[];
}

function classifyCheck(node: RawRollupNode): "success" | "failure" | "pending" {
  const typename = node.__typename ?? "";
  if (typename === "StatusContext") {
    const state = (node.state ?? "").toUpperCase();
    if (state === "SUCCESS" || state === "EXPECTED") return "success";
    if (state === "FAILURE" || state === "ERROR") return "failure";
    return "pending";
  }
  const status = (node.status ?? "").toUpperCase();
  if (status !== "COMPLETED") return "pending";
  const conclusion = (node.conclusion ?? "").toUpperCase();
  switch (conclusion) {
    case "SUCCESS":
    case "NEUTRAL":
    case "SKIPPED":
      return "success";
    case "FAILURE":
    case "CANCELLED":
    case "TIMED_OUT":
    case "STALE":
    case "ACTION_REQUIRED":
      return "failure";
    default:
      return "pending";
  }
}

function deriveCheckName(node: RawRollupNode): string | undefined {
  if (typeof node.name === "string" && node.name) return node.name;
  if (typeof node.context === "string" && node.context) return node.context;
  return undefined;
}

export function parsePrView(raw: string): PrGitHubOverview {
  const data = JSON.parse(raw) as RawPrView;
  const state = (data.state ?? "OPEN").toUpperCase() as PrGitHubState;
  const reviewDecision = (data.reviewDecision ?? "").toUpperCase() as PrGitHubReviewDecision;
  const labels = Array.isArray(data.labels) ? data.labels.map((label) => label.name).filter(Boolean) : [];
  const rollup = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];
  const checks: PrGitHubCheck[] = rollup
    .map<PrGitHubCheck | undefined>((node) => {
      const name = deriveCheckName(node);
      if (!name) return undefined;
      const detailsUrl = node.detailsUrl ?? node.targetUrl;
      return {
        name,
        status: classifyCheck(node),
        required: node.isRequired === true,
        ...(detailsUrl ? { detailsUrl } : {}),
      };
    })
    .filter((c): c is PrGitHubCheck => c !== undefined);

  return {
    number: data.number,
    branch: data.headRefName,
    headSha: data.headRefOid,
    state,
    merged: state === "MERGED",
    reviewDecision,
    ...(data.mergeStateStatus ? { mergeStateStatus: data.mergeStateStatus } : {}),
    labels,
    checks,
  };
}

export async function fetchPrGitHubOverview(
  repoFullName: string,
  prNumber: number,
  runCommand: ResolveCommandRunner,
): Promise<PrGitHubOverview> {
  const result = await runCommand("gh", [
    "pr", "view", String(prNumber),
    "--repo", repoFullName,
    "--json",
    "number,headRefName,headRefOid,state,reviewDecision,mergeStateStatus,labels,statusCheckRollup",
  ]);
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `gh pr view exited with ${result.exitCode}`;
    throw new Error(`Unable to fetch PR #${prNumber} from GitHub: ${message}`);
  }
  return parsePrView(result.stdout);
}
