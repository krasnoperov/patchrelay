import type { IssueMetadata, ProjectConfig, ProjectWorkflowConfig, ProjectWorkflowDefinition, WorkflowStage } from "./types.ts";

export type WorkflowTransitionTarget = WorkflowStage | "done" | "human_needed";

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeWorkflowLabel(value: string | undefined): string | undefined {
  return normalize(value)?.replace(/[\s_-]+/g, "");
}

function extractIssuePrefix(identifier?: string): string | undefined {
  const value = identifier?.trim();
  if (!value) {
    return undefined;
  }

  const [prefix] = value.split("-", 1);
  return prefix ? prefix.toUpperCase() : undefined;
}

function withWorkflowDefinitionId(workflowDefinitionId?: string): { workflowDefinitionId: string } | undefined {
  return workflowDefinitionId ? { workflowDefinitionId } : undefined;
}

export function listProjectWorkflowDefinitions(project: ProjectConfig): ProjectWorkflowDefinition[] {
  if (project.workflowDefinitions && project.workflowDefinitions.length > 0) {
    return project.workflowDefinitions;
  }

  return [
    {
      id: project.workflowSelection?.defaultWorkflowId ?? "default",
      stages: project.workflows,
    },
  ];
}

export function resolveWorkflowDefinitionById(project: ProjectConfig, workflowDefinitionId?: string): ProjectWorkflowDefinition | undefined {
  const normalized = normalize(workflowDefinitionId);
  if (!normalized) {
    return undefined;
  }

  return listProjectWorkflowDefinitions(project).find((definition) => normalize(definition.id) === normalized);
}

export function selectWorkflowDefinition(project: ProjectConfig, issue?: Pick<IssueMetadata, "labelNames">): ProjectWorkflowDefinition | undefined {
  const workflowDefinitions = listProjectWorkflowDefinitions(project);
  if (workflowDefinitions.length === 0) {
    return undefined;
  }

  const labelNames = new Set((issue?.labelNames ?? []).map((label) => label.trim().toLowerCase()).filter(Boolean));
  const matchedWorkflowIds = new Set<string>();
  for (const rule of project.workflowSelection?.byLabel ?? []) {
    if (labelNames.has(rule.label.trim().toLowerCase())) {
      matchedWorkflowIds.add(rule.workflowId);
    }
  }

  if (matchedWorkflowIds.size === 1) {
    const [workflowId] = [...matchedWorkflowIds];
    return resolveWorkflowDefinitionById(project, workflowId);
  }

  if (matchedWorkflowIds.size > 1) {
    return undefined;
  }

  if (project.workflowSelection?.defaultWorkflowId) {
    return resolveWorkflowDefinitionById(project, project.workflowSelection.defaultWorkflowId);
  }

  return workflowDefinitions[0];
}

function resolveStageList(
  project: ProjectConfig,
  options?: { workflowDefinitionId?: string; issue?: Pick<IssueMetadata, "labelNames"> },
): ProjectWorkflowConfig[] {
  if (options?.workflowDefinitionId) {
    return resolveWorkflowDefinitionById(project, options.workflowDefinitionId)?.stages ?? [];
  }

  if (options?.issue) {
    return selectWorkflowDefinition(project, options.issue)?.stages ?? [];
  }

  return project.workflows;
}

export function resolveWorkflow(
  project: ProjectConfig,
  stateName?: string,
  options?: { workflowDefinitionId?: string; issue?: Pick<IssueMetadata, "labelNames"> },
): ProjectWorkflowConfig | undefined {
  const normalized = normalize(stateName);
  if (!normalized) {
    return undefined;
  }

  return resolveStageList(project, options).find((workflow) => normalize(workflow.whenState) === normalized);
}

export function resolveWorkflowStage(
  project: ProjectConfig,
  stateName?: string,
  options?: { workflowDefinitionId?: string; issue?: Pick<IssueMetadata, "labelNames"> },
): WorkflowStage | undefined {
  return resolveWorkflow(project, stateName, options)?.id;
}

export function resolveWorkflowStageConfig(
  project: ProjectConfig,
  workflowId?: string,
  workflowDefinitionId?: string,
): ProjectWorkflowConfig | undefined {
  const normalized = normalize(workflowId);
  if (!normalized) {
    return undefined;
  }

  return resolveStageList(project, withWorkflowDefinitionId(workflowDefinitionId)).find((workflow) => normalize(workflow.id) === normalized);
}

export function listRunnableStates(
  project: ProjectConfig,
  options?: { workflowDefinitionId?: string; issue?: Pick<IssueMetadata, "labelNames"> },
): string[] {
  return [...new Set(resolveStageList(project, options).map((workflow) => workflow.whenState))];
}

export function listWorkflowStageIds(project: ProjectConfig, workflowDefinitionId?: string): WorkflowStage[] {
  return resolveStageList(project, withWorkflowDefinitionId(workflowDefinitionId)).map((workflow) => workflow.id);
}

export function resolveWorkflowIndex(project: ProjectConfig, workflowId?: string, workflowDefinitionId?: string): number {
  if (!workflowId) {
    return -1;
  }

  return resolveStageList(project, withWorkflowDefinitionId(workflowDefinitionId)).findIndex((workflow) => workflow.id === workflowId);
}

export function resolveDefaultTransitionTarget(
  project: ProjectConfig,
  currentStage: WorkflowStage,
  workflowDefinitionId?: string,
): WorkflowTransitionTarget | undefined {
  const stages = resolveStageList(project, withWorkflowDefinitionId(workflowDefinitionId));
  const currentIndex = resolveWorkflowIndex(project, currentStage, workflowDefinitionId);
  if (currentIndex < 0) {
    return undefined;
  }

  const nextStage = stages[currentIndex + 1]?.id;
  return nextStage ?? "done";
}

export function listAllowedTransitionTargets(
  project: ProjectConfig,
  currentStage: WorkflowStage,
  workflowDefinitionId?: string,
): WorkflowTransitionTarget[] {
  const stages = resolveStageList(project, withWorkflowDefinitionId(workflowDefinitionId));
  const currentIndex = resolveWorkflowIndex(project, currentStage, workflowDefinitionId);
  if (currentIndex < 0) {
    return ["human_needed"];
  }

  const targets = new Set<WorkflowTransitionTarget>(["human_needed"]);
  const defaultTarget = resolveDefaultTransitionTarget(project, currentStage, workflowDefinitionId);
  if (defaultTarget) {
    targets.add(defaultTarget);
  }

  if (currentIndex > 0) {
    targets.add(stages[currentIndex - 1]!.id);
  }
  if (currentIndex > 1) {
    targets.add(stages[0]!.id);
  }

  return [...targets];
}

export function transitionTargetAllowed(
  project: ProjectConfig,
  currentStage: WorkflowStage,
  nextTarget: WorkflowTransitionTarget,
  workflowDefinitionId?: string,
): boolean {
  return listAllowedTransitionTargets(project, currentStage, workflowDefinitionId).includes(nextTarget);
}

export function resolveWorkflowStageCandidate(
  project: ProjectConfig,
  value?: string,
  workflowDefinitionId?: string,
): WorkflowStage | undefined {
  const normalized = normalizeWorkflowLabel(value);
  if (!normalized) {
    return undefined;
  }

  return resolveStageList(project, withWorkflowDefinitionId(workflowDefinitionId)).find((workflow) => {
    const candidates = [workflow.id, workflow.whenState, workflow.activeState];
    return candidates.some((candidate) => normalizeWorkflowLabel(candidate) === normalized);
  })?.id;
}

export function matchesProject(issue: IssueMetadata, project: ProjectConfig): boolean {
  const issuePrefix = extractIssuePrefix(issue.identifier);
  const teamCandidates = [issue.teamId, issue.teamKey].filter((value): value is string => Boolean(value));
  const labelNames = new Set(issue.labelNames.map((label) => label.toLowerCase()));

  const matchesPrefix =
    project.issueKeyPrefixes.length === 0 ||
    (issuePrefix ? project.issueKeyPrefixes.map((value) => value.toUpperCase()).includes(issuePrefix) : false);
  const matchesTeam =
    project.linearTeamIds.length === 0 || teamCandidates.some((candidate) => project.linearTeamIds.includes(candidate));
  const matchesLabel =
    project.allowLabels.length === 0 || project.allowLabels.some((label) => labelNames.has(label.toLowerCase()));

  return matchesPrefix && matchesTeam && matchesLabel;
}
