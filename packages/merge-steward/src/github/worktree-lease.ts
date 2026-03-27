/**
 * Worktree lease contract. The steward only operates a worktree when
 * PatchRelay has released it (activeRunId is null for the corresponding issue).
 *
 * Status-based ownership:
 *   preparing_head, merging: steward holds the worktree
 *   repair_in_progress: PatchRelay holds the worktree (active run)
 *   validating, queued: nobody — CI runs on GitHub, no local git ops
 */
export interface WorktreeLease {
  /**
   * Check if the worktree is available for the steward to operate.
   * The issueKey identifies the PatchRelay issue that owns the worktree.
   * Returns true if PatchRelay has no active run for this issue.
   */
  isAvailable(issueKey: string): Promise<boolean>;
}

/**
 * Production implementation: checks PatchRelay's API.
 */
export class PatchRelayLease implements WorktreeLease {
  constructor(private readonly patchrelayApiUrl: string) {}

  async isAvailable(issueKey: string): Promise<boolean> {
    try {
      const resp = await fetch(
        `${this.patchrelayApiUrl}/api/issues/${encodeURIComponent(issueKey)}`,
      );
      if (!resp.ok) return false;
      const data = (await resp.json()) as { activeRunId?: unknown };
      return data.activeRunId === undefined || data.activeRunId === null;
    } catch {
      // If PatchRelay is unreachable, assume not available (safe default).
      return false;
    }
  }
}

/**
 * Test/standalone implementation: always available.
 */
export class AlwaysAvailableLease implements WorktreeLease {
  async isAvailable(): Promise<boolean> {
    return true;
  }
}
