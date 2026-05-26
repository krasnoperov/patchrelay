import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import {
  isDelegatedToPatchRelay,
  resolveDelegationTruth,
} from "../src/webhooks/delegation-truth.ts";
import type { IssueMetadata, ProjectConfig } from "../src/types.ts";

function setupDb(projectId: string, actorId?: string) {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-delegation-truth-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  if (actorId) {
    const installation = db.linearInstallations.upsertLinearInstallation({
      workspaceId: "workspace-1",
      actorId,
      accessTokenCiphertext: "ct",
      scopesJson: JSON.stringify(["read"]),
    });
    db.linearInstallations.linkProjectInstallation(projectId, installation.id);
  }
  return { db, baseDir };
}

function makeProject(id: string): ProjectConfig {
  return {
    id,
    linearTeamId: "team-1",
  } as ProjectConfig;
}

function makeIssue(overrides: Partial<IssueMetadata> = {}): IssueMetadata {
  return {
    id: "linear-issue-1",
    blockedBy: [],
    attachments: [],
    relationsKnown: true,
    ...overrides,
  } as IssueMetadata;
}

test("isDelegatedToPatchRelay returns false when no installation is linked", () => {
  const { db, baseDir } = setupDb("project-1");
  try {
    assert.equal(
      isDelegatedToPatchRelay(db, makeProject("project-1"), { delegateId: "actor-1" }),
      false,
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("isDelegatedToPatchRelay returns true only when the delegateId matches the installation actor", () => {
  const { db, baseDir } = setupDb("project-1", "actor-1");
  try {
    assert.equal(
      isDelegatedToPatchRelay(db, makeProject("project-1"), { delegateId: "actor-1" }),
      true,
    );
    assert.equal(
      isDelegatedToPatchRelay(db, makeProject("project-1"), { delegateId: "actor-other" }),
      false,
    );
    assert.equal(isDelegatedToPatchRelay(db, makeProject("project-1"), {}), false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resolveDelegationTruth uses the observed delegate id when present", () => {
  const { db, baseDir } = setupDb("project-1", "actor-1");
  try {
    const result = resolveDelegationTruth({
      db,
      project: makeProject("project-1"),
      normalizedIssue: makeIssue(),
      hydratedIssue: makeIssue({ delegateId: "actor-1" }),
      existingIssue: undefined,
      triggerEvent: "delegateChanged",
      webhookId: "webhook-1",
      hydration: "webhook_only",
    });
    assert.equal(result.delegated, true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resolveDelegationTruth preserves the previous delegation when the webhook omits delegate identity", () => {
  const { db, baseDir } = setupDb("project-1", "actor-1");
  try {
    const result = resolveDelegationTruth({
      db,
      project: makeProject("project-1"),
      normalizedIssue: makeIssue(),
      hydratedIssue: makeIssue({ delegateId: undefined }),
      existingIssue: { delegatedToPatchRelay: true } as never,
      triggerEvent: "issueUpdated",
      webhookId: "webhook-1",
      hydration: "webhook_only",
    });
    // Previously delegated → preserved even though the webhook didn't include a delegate.
    assert.equal(result.delegated, true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resolveDelegationTruth treats live Linear missing delegate as authoritative undelegation", () => {
  const { db, baseDir } = setupDb("project-1", "actor-1");
  try {
    const result = resolveDelegationTruth({
      db,
      project: makeProject("project-1"),
      normalizedIssue: makeIssue(),
      hydratedIssue: makeIssue({ delegateId: undefined }),
      existingIssue: { delegatedToPatchRelay: true } as never,
      triggerEvent: "statusChanged",
      webhookId: "webhook-1",
      hydration: "live_linear",
    });
    assert.equal(result.delegated, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resolveDelegationTruth honors an explicit delegateChanged trigger that drops the delegate", () => {
  const { db, baseDir } = setupDb("project-1", "actor-1");
  try {
    const result = resolveDelegationTruth({
      db,
      project: makeProject("project-1"),
      normalizedIssue: makeIssue(),
      hydratedIssue: makeIssue({ delegateId: undefined }),
      existingIssue: { delegatedToPatchRelay: true } as never,
      triggerEvent: "delegateChanged",
      webhookId: "webhook-1",
      hydration: "webhook_only",
    });
    // Explicit delegate-change signal → trust the observation, even when blank.
    assert.equal(result.delegated, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resolveDelegationTruth treats absent installation as not delegated", () => {
  const { db, baseDir } = setupDb("project-1");
  try {
    const result = resolveDelegationTruth({
      db,
      project: makeProject("project-1"),
      normalizedIssue: makeIssue(),
      hydratedIssue: makeIssue({ delegateId: "actor-1" }),
      existingIssue: undefined,
      triggerEvent: "delegateChanged",
      webhookId: "webhook-1",
      hydration: "webhook_only",
    });
    assert.equal(result.delegated, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
