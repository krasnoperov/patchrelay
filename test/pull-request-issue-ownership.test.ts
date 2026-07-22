import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { attachmentDeclaresDelivery, pullRequestOwnsIssue } from "../src/pull-request-issue-ownership.ts";
import { resolveLinkedPrAdoption } from "../src/webhooks/linked-pr-adoption.ts";
import type { ProjectConfig } from "../src/types.ts";

test("accepts exact issue ownership evidence from PR metadata", () => {
  assert.equal(pullRequestOwnsIssue({ body: "Linear: INV-808" }, "INV-808"), true);
  assert.equal(pullRequestOwnsIssue({ title: "fix(INV-808): authorize attempts" }, "INV-808"), true);
  assert.equal(pullRequestOwnsIssue({ headRefName: "inventory/inv-808-authorize-attempts" }, "INV-808"), true);
});

test("rejects relevant or regression PRs that belong to another issue", () => {
  assert.equal(pullRequestOwnsIssue({
    title: "fix(generation): make workflow startup idempotent",
    body: "Linear: INV-803",
    headRefName: "feature/inv-803-idempotent-workflow-start",
  }, "INV-808"), false);
});

test("does not confuse an issue key with a longer identifier", () => {
  assert.equal(pullRequestOwnsIssue({ body: "Linear: INV-8080" }, "INV-808"), false);
});

test("recognizes only exact PatchRelay delivery attachment metadata", () => {
  const attachment = {
    id: "attachment-808",
    url: "https://github.com/krasnoperov/inventory/pull/920",
    metadata: { patchrelayRelationship: "delivery_pr", patchrelayIssueKey: "INV-808" },
  };
  assert.equal(attachmentDeclaresDelivery(attachment, "INV-808"), true);
  assert.equal(attachmentDeclaresDelivery(attachment, "INV-809"), false);
  assert.equal(attachmentDeclaresDelivery({ ...attachment, metadata: undefined }, "INV-808"), false);
});

test("does not adopt a merged regression-evidence attachment as delivery", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-pr-ownership-"));
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  const previousPath = process.env.PATH;
  try {
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
printf '%s' '{"title":"fix generation startup","body":"Linear: INV-803","headRefName":"feature/inv-803-startup","state":"MERGED","url":"https://github.com/krasnoperov/inventory/pull/916"}'
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;

    const project = {
      id: "krasnoperov/inventory",
      repoPath: baseDir,
      worktreeRoot: path.join(baseDir, "worktrees"),
      issueKeyPrefixes: ["INV"],
      linearTeamIds: ["INV"],
      allowLabels: [],
      triggerEvents: ["agentSessionCreated"],
      branchPrefix: "inventory",
      github: { repoFullName: "krasnoperov/inventory" },
    } satisfies ProjectConfig;

    const adoption = await resolveLinkedPrAdoption({
      project,
      delegated: true,
      triggerEvent: "agentSessionCreated",
      existingIssue: undefined,
      issue: {
        id: "issue-inv-808",
        identifier: "INV-808",
        title: "Authorize durable generation attempts",
        labelNames: [],
        blockedBy: [],
        blocks: [],
        attachments: [{
          id: "evidence-pr-916",
          title: "Regression-introducing PR #916",
          url: "https://github.com/krasnoperov/inventory/pull/916",
        }],
      },
    });

    assert.equal(adoption, undefined);
  } finally {
    process.env.PATH = previousPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
