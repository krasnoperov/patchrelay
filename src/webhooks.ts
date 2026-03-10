import type { CommentMetadata, IssueMetadata, LinearActorMetadata, LinearWebhookPayload, NormalizedEvent, TriggerEvent } from "./types.js";

function deriveTriggerEvent(payload: LinearWebhookPayload): TriggerEvent {
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
    if (updatedFields.has("assigneeId")) {
      return "assignmentChanged";
    }
    if (updatedFields.has("delegateId")) {
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

  return "issueUpdated";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
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
  const data = asRecord(payload.data);
  if (!data) {
    return undefined;
  }

  const issueRecord =
    payload.type === "Issue"
      ? data
      : (() => {
          const nestedIssue = asRecord(data.issue);
          return nestedIssue ?? data;
        })();

  const id = getString(issueRecord, "id") ?? getString(data, "issueId");
  if (!id) {
    return undefined;
  }

  const teamRecord = asRecord(issueRecord.team);
  const identifier = getString(issueRecord, "identifier");
  const title = getString(issueRecord, "title");
  const url = getString(issueRecord, "url") ?? payload.url;
  const teamId = getString(issueRecord, "teamId") ?? getString(teamRecord ?? {}, "id");
  const teamKey = getString(teamRecord ?? {}, "key");
  const stateRecord = asRecord(issueRecord.state);
  const stateId = getString(issueRecord, "stateId") ?? getString(stateRecord ?? {}, "id");
  const stateName = getString(stateRecord ?? {}, "name");
  const stateType = getString(stateRecord ?? {}, "type");

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
  if (payload.type !== "Comment") {
    return undefined;
  }

  const data = asRecord(payload.data);
  if (!data) {
    return undefined;
  }

  const id = getString(data, "id");
  const body = getString(data, "body");
  const userRecord = asRecord(data.user);
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

export function normalizeWebhook(params: {
  webhookId: string;
  payload: LinearWebhookPayload;
}): NormalizedEvent {
  const issue = extractIssueMetadata(params.payload);
  const comment = extractCommentMetadata(params.payload);
  const actor = extractActorMetadata(params.payload);
  if (!issue) {
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
    issue,
    ...(comment ? { comment } : {}),
    payload: params.payload,
  };
}
