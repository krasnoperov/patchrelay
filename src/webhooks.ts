import type {
  AgentSessionMetadata,
  CommentMetadata,
  IssueMetadata,
  InstallationWebhookMetadata,
  LinearActorMetadata,
  LinearWebhookPayload,
  NormalizedEvent,
  TriggerEvent,
} from "./types.ts";

function getPayloadRecord(payload: LinearWebhookPayload): Record<string, unknown> {
  return payload as unknown as Record<string, unknown>;
}

function getPayloadData(payload: LinearWebhookPayload): Record<string, unknown> {
  return asRecord(getPayloadRecord(payload).data) ?? getPayloadRecord(payload);
}

function getNestedRecord(record: Record<string, unknown> | undefined, path: string[]): Record<string, unknown> | undefined {
  let current: unknown = record;
  for (const segment of path) {
    const currentRecord = asRecord(current);
    if (!currentRecord) {
      return undefined;
    }
    current = currentRecord[segment];
  }
  return asRecord(current);
}

function getFirstNestedRecord(record: Record<string, unknown> | undefined, paths: string[][]): Record<string, unknown> | undefined {
  for (const path of paths) {
    const candidate = getNestedRecord(record, path);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function looksLikeIssueRecord(record: Record<string, unknown> | undefined): boolean {
  if (!record) {
    return false;
  }

  return Boolean(
    getString(record, "identifier") ||
      getString(record, "title") ||
      getString(record, "delegateId") ||
      asRecord(record.delegate) ||
      asRecord(record.team) ||
      asRecord(record.state) ||
      Array.isArray(record.labels),
  );
}

function deriveTriggerEvent(payload: LinearWebhookPayload): TriggerEvent {
  const data = getPayloadData(payload);
  const hasAgentSession =
    Boolean(
      getFirstNestedRecord(data, [
        ["agentSession"],
        ["session"],
        ["agentSessionEvent", "agentSession"],
        ["payload", "agentSession"],
        ["resource", "agentSession"],
      ]),
    ) || Boolean(getString(data, "agentSessionId"));

  if (payload.type === "AgentSessionEvent" || payload.type === "AgentSession" || hasAgentSession) {
    if (payload.action === "created" || payload.action === "create") {
      return "agentSessionCreated";
    }
    if (payload.action === "prompted" || payload.action === "prompt") {
      return "agentPrompted";
    }
    return "issueUpdated";
  }

  if (payload.type === "Issue") {
    if (payload.action === "create") {
      return "issueCreated";
    }
    if (payload.action === "remove") {
      return "issueRemoved";
    }

    const updatedFields = new Set(Object.keys(payload.updatedFrom ?? {}));
    if (updatedFields.has("labels")) {
      return "labelChanged";
    }
    if (updatedFields.has("stateId") || updatedFields.has("state")) {
      return "statusChanged";
    }
    if (updatedFields.has("assigneeId") || updatedFields.has("assignee")) {
      return "assignmentChanged";
    }
    if (updatedFields.has("delegateId") || updatedFields.has("delegate")) {
      return "delegateChanged";
    }
    return "issueUpdated";
  }

  if (payload.type === "Comment") {
    if (payload.action === "create") {
      return "commentCreated";
    }
    if (payload.action === "remove") {
      return "commentRemoved";
    }
    return "commentUpdated";
  }

  if (payload.type === "PermissionChange") {
    return "installationPermissionsChanged";
  }

  if (payload.type === "OAuthApp" && payload.action === "revoked") {
    return "installationRevoked";
  }

  if (payload.type === "AppUserNotification") {
    return "appUserNotification";
  }

  return "issueUpdated";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function getStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function extractLabelNames(record: Record<string, unknown>): string[] {
  const source = record.labels;
  if (Array.isArray(source)) {
    return source
      .flatMap((entry) => {
        if (typeof entry === "string") {
          return [entry];
        }
        const entryRecord = asRecord(entry);
        const name = entryRecord ? getString(entryRecord, "name") : undefined;
        return name ? [name] : [];
      })
      .filter(Boolean);
  }

  const labelsRecord = asRecord(source);
  const nodes = labelsRecord?.nodes;
  if (Array.isArray(nodes)) {
    return nodes
      .flatMap((entry) => {
        const entryRecord = asRecord(entry);
        const name = entryRecord ? getString(entryRecord, "name") : undefined;
        return name ? [name] : [];
      })
      .filter(Boolean);
  }

  return [];
}

function extractIssueMetadata(payload: LinearWebhookPayload): IssueMetadata | undefined {
  const data = getPayloadData(payload);
  const sessionRecord =
    getFirstNestedRecord(data, [
      ["agentSession"],
      ["session"],
      ["agentSessionEvent", "agentSession"],
      ["payload", "agentSession"],
      ["resource", "agentSession"],
    ]) ?? data;
  const commentRecord = getFirstNestedRecord(data, [["comment"]]);
  const notificationRecord = getFirstNestedRecord(data, [["notification"]]) ?? data;

  const issueRecord =
    payload.type === "Issue"
      ? data
      : payload.type === "AppUserNotification"
        ? getFirstNestedRecord(notificationRecord, [["issue"], ["comment", "issue"]]) ?? getFirstNestedRecord(data, [["issue"]])
        : getFirstNestedRecord(data, [
            ["issue"],
            ["agentSession", "issue"],
            ["session", "issue"],
            ["agentSessionEvent", "issue"],
            ["agentSessionEvent", "agentSession", "issue"],
            ["payload", "issue"],
            ["payload", "agentSession", "issue"],
            ["resource", "issue"],
            ["resource", "agentSession", "issue"],
            ["comment", "issue"],
            ["comment", "parent", "issue"],
            ["comment", "commentThread", "issue"],
            ["comment", "parentEntity", "issue"],
            ["parent", "issue"],
            ["commentThread", "issue"],
            ["parentEntity", "issue"],
            ["notification", "issue"],
            ["notification", "comment", "issue"],
          ]) ??
          (looksLikeIssueRecord(sessionRecord) ? sessionRecord : undefined) ??
          (looksLikeIssueRecord(commentRecord) ? commentRecord : undefined);

  if (!issueRecord) {
    return undefined;
  }

  const id = getString(issueRecord, "id") ?? getString(data, "issueId");
  if (!id) {
    return undefined;
  }

  const teamRecord = asRecord(issueRecord.team);
  const identifier = getString(issueRecord, "identifier");
  const title = getString(issueRecord, "title");
  const url = getString(issueRecord, "url") ?? payload.url;
  const delegateRecord = asRecord(issueRecord.delegate);
  const teamId = getString(issueRecord, "teamId") ?? getString(teamRecord ?? {}, "id");
  const teamKey = getString(teamRecord ?? {}, "key");
  const stateRecord = asRecord(issueRecord.state);
  const stateId = getString(issueRecord, "stateId") ?? getString(stateRecord ?? {}, "id");
  const stateName = getString(stateRecord ?? {}, "name");
  const stateType = getString(stateRecord ?? {}, "type");
  const delegateId = getString(issueRecord, "delegateId") ?? getString(delegateRecord ?? {}, "id");
  const delegateName = getString(delegateRecord ?? {}, "name");

  return {
    id,
    ...(identifier ? { identifier } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(teamId ? { teamId } : {}),
    ...(teamKey ? { teamKey } : {}),
    ...(stateId ? { stateId } : {}),
    ...(stateName ? { stateName } : {}),
    ...(stateType ? { stateType } : {}),
    ...(delegateId ? { delegateId } : {}),
    ...(delegateName ? { delegateName } : {}),
    labelNames: extractLabelNames(issueRecord),
  };
}

function extractActorFromRecord(record: Record<string, unknown> | undefined): LinearActorMetadata | undefined {
  if (!record) {
    return undefined;
  }

  const nestedUser = asRecord(record.user);
  const id = getString(record, "id") ?? getString(record, "actorId") ?? getString(record, "userId") ?? getString(nestedUser ?? {}, "id");
  const name = getString(record, "name") ?? getString(nestedUser ?? {}, "name");
  const email = getString(record, "email") ?? getString(nestedUser ?? {}, "email");
  const type = getString(record, "type") ?? getString(record, "__typename");

  if (!id && !name && !email && !type) {
    return undefined;
  }

  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(type ? { type } : {}),
  };
}

function extractActorMetadata(payload: LinearWebhookPayload): LinearActorMetadata | undefined {
  const payloadActor = extractActorFromRecord(asRecord((payload as unknown as Record<string, unknown>).actor));
  if (payloadActor) {
    return payloadActor;
  }

  const data = asRecord(payload.data);
  const fallbacks = [
    extractActorFromRecord(asRecord(data?.actor)),
    extractActorFromRecord(asRecord(data?.user)),
    extractActorFromRecord(asRecord(data?.creator)),
    extractActorFromRecord(asRecord(data?.createdBy)),
  ];

  return fallbacks.find(Boolean);
}

function extractCommentMetadata(payload: LinearWebhookPayload): CommentMetadata | undefined {
  const data = getPayloadData(payload);
  const commentRecord =
    payload.type === "Comment"
      ? data
      : getFirstNestedRecord(data, [
          ["comment"],
          ["agentSession", "comment"],
          ["session", "comment"],
          ["agentSessionEvent", "comment"],
          ["payload", "comment"],
          ["resource", "comment"],
          ["notification", "comment"],
        ]);

  if (!commentRecord) {
    return undefined;
  }

  const id = getString(commentRecord, "id");
  const body = getString(commentRecord, "body");
  const userRecord = asRecord(commentRecord.user);
  const userName = getString(userRecord ?? {}, "name");
  if (!id) {
    return undefined;
  }

  return {
    id,
    ...(body ? { body } : {}),
    ...(userName ? { userName } : {}),
  };
}

function extractAgentSessionMetadata(payload: LinearWebhookPayload): AgentSessionMetadata | undefined {
  const data = getPayloadData(payload);
  const sessionRecord =
    getFirstNestedRecord(data, [
      ["agentSession"],
      ["session"],
      ["agentSessionEvent", "agentSession"],
      ["payload", "agentSession"],
      ["resource", "agentSession"],
    ]) ?? (payload.type === "AgentSession" ? data : undefined);
  if (payload.type !== "AgentSessionEvent" && payload.type !== "AgentSession" && !sessionRecord && !getString(data, "agentSessionId")) {
    return undefined;
  }

  const id = getString(sessionRecord ?? {}, "id") ?? getString(data, "agentSessionId");
  if (!id) {
    return undefined;
  }

  const agentActivity = getFirstNestedRecord(data, [
    ["agentActivity"],
    ["agentSession", "agentActivity"],
    ["session", "agentActivity"],
    ["agentSessionEvent", "agentActivity"],
    ["payload", "agentActivity"],
    ["resource", "agentActivity"],
  ]);
  const commentRecord =
    getFirstNestedRecord(data, [
      ["comment"],
      ["agentSession", "comment"],
      ["session", "comment"],
      ["agentSessionEvent", "comment"],
      ["payload", "comment"],
      ["resource", "comment"],
    ]) ??
    getFirstNestedRecord(sessionRecord, [["comment"]]);
  const promptContext = getString(data, "promptContext") ?? getString(sessionRecord ?? {}, "promptContext");
  const promptBody =
    getString(agentActivity ?? {}, "body") ??
    getString(commentRecord ?? {}, "body") ??
    getString(data, "body");
  const issueCommentId = getString(commentRecord ?? {}, "id") ?? getString(data, "issueCommentId");

  return {
    id,
    ...(promptContext ? { promptContext } : {}),
    ...(promptBody ? { promptBody } : {}),
    ...(issueCommentId ? { issueCommentId } : {}),
  };
}

function extractInstallationMetadata(payload: LinearWebhookPayload): InstallationWebhookMetadata | undefined {
  const data = getPayloadData(payload);

  if (payload.type === "PermissionChange") {
    const organizationId = getString(data, "organizationId");
    const oauthClientId = getString(data, "oauthClientId");
    const appUserId = getString(data, "appUserId");
    const canAccessAllPublicTeams = getBoolean(data, "canAccessAllPublicTeams");
    return {
      ...(organizationId ? { organizationId } : {}),
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(appUserId ? { appUserId } : {}),
      ...(canAccessAllPublicTeams !== undefined ? { canAccessAllPublicTeams } : {}),
      addedTeamIds: getStringArray(data, "addedTeamIds"),
      removedTeamIds: getStringArray(data, "removedTeamIds"),
    };
  }

  if (payload.type === "OAuthApp") {
    const organizationId = getString(data, "organizationId");
    const oauthClientId = getString(data, "oauthClientId");
    return {
      ...(organizationId ? { organizationId } : {}),
      ...(oauthClientId ? { oauthClientId } : {}),
      addedTeamIds: [],
      removedTeamIds: [],
    };
  }

  if (payload.type === "AppUserNotification") {
    const notificationRecord = asRecord(data.notification) ?? data;
    const organizationId = getString(data, "organizationId");
    const oauthClientId = getString(data, "oauthClientId");
    const appUserId = getString(data, "appUserId");
    const notificationType = getString(notificationRecord, "type");
    return {
      ...(organizationId ? { organizationId } : {}),
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(appUserId ? { appUserId } : {}),
      ...(notificationType ? { notificationType } : {}),
      addedTeamIds: [],
      removedTeamIds: [],
    };
  }

  return undefined;
}

export function normalizeWebhook(params: {
  webhookId: string;
  payload: LinearWebhookPayload;
}): NormalizedEvent {
  const issue = extractIssueMetadata(params.payload);
  const comment = extractCommentMetadata(params.payload);
  const agentSession = extractAgentSessionMetadata(params.payload);
  const installation = extractInstallationMetadata(params.payload);
  const actor = extractActorMetadata(params.payload);
  if (!issue && !installation) {
    throw new Error(`Unable to determine issue metadata from ${params.payload.type} webhook`);
  }

  const triggerEvent = deriveTriggerEvent(params.payload);
  return {
    webhookId: params.webhookId,
    entityType: params.payload.type,
    action: params.payload.action,
    triggerEvent,
    eventType: `${params.payload.type}.${params.payload.action}`,
    ...(actor ? { actor } : {}),
    ...(issue ? { issue } : {}),
    ...(comment ? { comment } : {}),
    ...(agentSession ? { agentSession } : {}),
    ...(installation ? { installation } : {}),
    payload: params.payload,
  };
}
