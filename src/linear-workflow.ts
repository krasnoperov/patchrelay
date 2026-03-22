function normalizeLinearState(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
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
