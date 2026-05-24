function normalizeLinearState(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function includesAny(normalized: string | undefined, candidates: string[]): boolean {
  return Boolean(normalized && candidates.includes(normalized));
}

function resolvePreferredLinearState(issue: {
  workflowStates: Array<{ name: string; type?: string }>;
}, params: {
  names: string[];
  types?: string[] | undefined;
  fallback?: string | undefined;
}): string | undefined {
  const match = issue.workflowStates.find((state) => {
    const normalizedType = normalizeLinearState(state.type);
    const normalizedName = normalizeLinearState(state.name);
    if (params.types && !params.types.includes(normalizedType ?? "")) {
      return false;
    }
    return includesAny(normalizedName, params.names);
  });
  return match?.name ?? params.fallback;
}

export function resolvePreferredStartedLinearState(issue: {
  workflowStates: Array<{ name: string; type?: string }>;
}): string | undefined {
  const startedStates = issue.workflowStates.filter((state) => normalizeLinearState(state.type) === "started");
  const preferred = startedStates.find((state) => {
    const normalized = normalizeLinearState(state.name);
    return normalized === "in progress" || normalized === "in-progress" || normalized === "started" || normalized === "doing";
  });
  return preferred?.name ?? startedStates[0]?.name;
}

export function resolvePreferredQueuedLinearState(issue: {
  workflowStates: Array<{ name: string; type?: string }>;
}): string | undefined {
  return resolvePreferredLinearState(issue, {
    names: ["backlog", "start", "todo", "to do", "planned", "ready"],
    types: ["backlog", "unstarted"],
    fallback: issue.workflowStates.find((state) => {
      const normalizedType = normalizeLinearState(state.type);
      return normalizedType === "backlog" || normalizedType === "unstarted";
    })?.name,
  });
}

export function resolvePreferredImplementingLinearState(issue: {
  workflowStates: Array<{ name: string; type?: string }>;
}): string | undefined {
  return resolvePreferredLinearState(issue, {
    names: ["implementing", "in progress", "in-progress", "started", "doing"],
    types: ["started"],
    fallback: resolvePreferredStartedLinearState(issue),
  });
}

export function resolvePreferredReviewLinearState(issue: {
  workflowStates: Array<{ name: string; type?: string }>;
}): string | undefined {
  return resolvePreferredLinearState(issue, {
    names: ["review", "awaiting review"],
    types: ["unstarted"],
    fallback: resolvePreferredLinearState(issue, {
      names: ["reviewing", "in review", "review"],
      types: ["started"],
      fallback: resolvePreferredStartedLinearState(issue),
    }),
  });
}

export function resolvePreferredReviewingLinearState(issue: {
  workflowStates: Array<{ name: string; type?: string }>;
}): string | undefined {
  return resolvePreferredLinearState(issue, {
    names: ["reviewing", "in review", "review"],
    types: ["started"],
    fallback: resolvePreferredReviewLinearState(issue),
  });
}

// The pre-merge "approved, awaiting/undergoing landing" phase. Covers a
// PR that is queued, being tested in the speculative branch, or actively
// merging — i.e. everything the merge queue owns up to (but not past)
// the merge. NOT post-merge: that is `resolvePreferredDeployingLinearState`.
// Without a dedicated queue state, collapses to the reviewing state (and
// the `queued-for-deploy` label disambiguates — see state-sync).
export function resolvePreferredMergeQueueLinearState(issue: {
  workflowStates: Array<{ name: string; type?: string }>;
}): string | undefined {
  return resolvePreferredLinearState(issue, {
    names: ["in merge queue", "merge queue", "in queue", "queued", "queue", "merging", "landing", "ready to merge"],
    types: ["started"],
    fallback: resolvePreferredLinearState(issue, {
      names: ["in merge queue", "merge queue", "queued", "ready to merge", "ready to deploy", "ready for deploy", "to deploy", "merge"],
      types: ["unstarted"],
      fallback: resolvePreferredReviewingLinearState(issue),
    }),
  });
}

// Unstarted deploy column, used as a fallback by the started variant.
export function resolvePreferredDeployLinearState(issue: {
  workflowStates: Array<{ name: string; type?: string }>;
}): string | undefined {
  return resolvePreferredLinearState(issue, {
    names: ["deploy", "to deploy", "ready to ship"],
    types: ["unstarted"],
    fallback: resolvePreferredMergeQueueLinearState(issue),
  });
}

// Strictly POST-merge: the change is on main and the deploy workflow is
// running. "merging" lives in the merge-queue phase, not here. Without a
// dedicated deploy state, collapses back to the merge-queue state.
export function resolvePreferredDeployingLinearState(issue: {
  workflowStates: Array<{ name: string; type?: string }>;
}): string | undefined {
  return resolvePreferredLinearState(issue, {
    names: ["deploying", "deployment", "in deploy", "shipping", "releasing", "rollout"],
    types: ["started"],
    fallback: resolvePreferredDeployLinearState(issue),
  });
}

export function resolvePreferredHumanNeededLinearState(issue: {
  workflowStates: Array<{ name: string; type?: string }>;
}): string | undefined {
  return resolvePreferredLinearState(issue, {
    names: ["human needed", "needs human", "help needed", "operator needed", "blocked"],
    fallback: undefined,
  });
}

export function resolvePreferredCompletedLinearState(issue: {
  stateName?: string;
  workflowStates: Array<{ name: string; type?: string }>;
}): string | undefined {
  const completed = issue.workflowStates.find((state) => normalizeLinearState(state.type) === "completed");
  if (completed?.name) {
    return completed.name;
  }

  const currentStateName = issue.stateName?.trim();
  const normalizedCurrentState = normalizeLinearState(currentStateName);
  if (normalizedCurrentState === "done" || normalizedCurrentState === "completed" || normalizedCurrentState === "complete") {
    return currentStateName;
  }

  const named = issue.workflowStates.find((state) => {
    const normalized = normalizeLinearState(state.name);
    return normalized === "done" || normalized === "completed" || normalized === "complete";
  });
  return named?.name;
}

export function resolveAuthoritativeLinearStopState(issue: {
  stateName?: string;
  workflowStates: Array<{ name: string; type?: string }>;
}): { stateName: string; isFinal: boolean } | undefined {
  const currentStateName = issue.stateName?.trim();
  const normalizedCurrentState = normalizeLinearState(currentStateName);
  if (!currentStateName || !normalizedCurrentState) {
    return undefined;
  }

  const currentWorkflowState = issue.workflowStates.find((state) => normalizeLinearState(state.name) === normalizedCurrentState);
  if (normalizeLinearState(currentWorkflowState?.type) === "completed") {
    return { stateName: currentWorkflowState?.name ?? currentStateName, isFinal: true };
  }

  if (normalizedCurrentState === "done" || normalizedCurrentState === "completed" || normalizedCurrentState === "complete") {
    return { stateName: currentStateName, isFinal: true };
  }

  if (normalizedCurrentState === "human needed") {
    return { stateName: currentStateName, isFinal: false };
  }

  return undefined;
}
