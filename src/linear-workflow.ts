function normalizeLinearState(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
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
