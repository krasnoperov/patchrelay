const GITHUB_NATIVE_SUBJECT_PREFIX = "github-pr:";

/** Durable PatchRelay subject owned by GitHub rather than a Linear issue. */
export function githubNativeSubjectId(repoFullName: string, prNumber: number): string {
  return `${GITHUB_NATIVE_SUBJECT_PREFIX}${repoFullName}#${prNumber}`;
}

export function isGitHubNativeSubject(linearIssueId: string): boolean {
  return linearIssueId.startsWith(GITHUB_NATIVE_SUBJECT_PREFIX);
}
