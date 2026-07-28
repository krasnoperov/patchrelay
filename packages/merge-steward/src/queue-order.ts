import type { QueueEntry } from "./types.ts";

function compareReady(left: QueueEntry, right: QueueEntry): number {
  return (right.priority - left.priority) || (left.position - right.position);
}

/**
 * Order active entries without allowing priority to violate a stacked PR
 * dependency. Priority is considered only among entries whose active parent
 * has already appeared in the result.
 *
 * Cycles are impossible for a valid GitHub PR stack. Keep malformed cyclic
 * entries at the tail in deterministic order; the reconciler's dependency
 * guard will refuse to prepare them while their parent remains active.
 */
export function orderActiveQueue(entries: QueueEntry[]): QueueEntry[] {
  const byBranch = new Map(entries.map((entry) => [entry.branch, entry]));
  const children = new Map<string, QueueEntry[]>();
  const remainingParents = new Map<string, number>();

  for (const entry of entries) {
    const parent = entry.baseRefName ? byBranch.get(entry.baseRefName) : undefined;
    remainingParents.set(entry.id, parent ? 1 : 0);
    if (parent) {
      const list = children.get(parent.id) ?? [];
      list.push(entry);
      children.set(parent.id, list);
    }
  }

  const ready = entries
    .filter((entry) => remainingParents.get(entry.id) === 0)
    .sort(compareReady);
  const ordered: QueueEntry[] = [];
  const emitted = new Set<string>();

  while (ready.length > 0) {
    const entry = ready.shift()!;
    if (emitted.has(entry.id)) continue;
    emitted.add(entry.id);
    ordered.push(entry);

    for (const child of children.get(entry.id) ?? []) {
      const next = (remainingParents.get(child.id) ?? 0) - 1;
      remainingParents.set(child.id, next);
      if (next === 0) {
        ready.push(child);
        ready.sort(compareReady);
      }
    }
  }

  const malformed = entries.filter((entry) => !emitted.has(entry.id)).sort(compareReady);
  return [...ordered, ...malformed];
}
