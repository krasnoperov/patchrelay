import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendDelegationObservedEvent, appendRunReleasedAuthorityEvent } from "../src/delegation-audit.ts";
import { CliDataAccess } from "../src/cli/data.ts";
import { formatAudit } from "../src/cli/formatters/text.ts";
import { PatchRelayDatabase } from "../src/db.ts";
import type { AppConfig } from "../src/types.ts";

function createConfig(baseDir: string): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8787,
      healthPath: "/health",
      readinessPath: "/ready",
    },
    ingress: {
      linearWebhookPath: "/webhooks/linear",
      githubWebhookPath: "/webhooks/github",
      maxBodyBytes: 262144,
      maxTimestampSkewSeconds: 60,
    },
    logging: {
      level: "info",
      format: "logfmt",
      filePath: path.join(baseDir, "patchrelay.log"),
    },
    database: {
      path: path.join(baseDir, "patchrelay.sqlite"),
      wal: true,
    },
    linear: {
      webhookSecret: "",
      graphqlUrl: "https://linear.example/graphql",
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "app",
      },
      tokenEncryptionKey: "0123456789abcdef0123456789abcdef",
    },
    operatorApi: {
      enabled: false,
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: false,
      },
    },
    projects: [
      {
        id: "usertold",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "use",
      },
    ],
    secretSources: {},
  };
}

test("issue audit surfaces delegation observations and authority releases", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-issue-audit-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-audit",
      issueKey: "USE-77",
      title: "Audit delegation drift",
      delegatedToPatchRelay: true,
      factoryState: "pr_open",
      prNumber: 77,
      prState: "open",
    });

    appendDelegationObservedEvent(db, {
      projectId: "usertold",
      linearIssueId: "issue-audit",
      payload: {
        source: "linear_webhook",
        webhookId: "delivery-1",
        triggerEvent: "statusChanged",
        previousDelegatedToPatchRelay: true,
        observedDelegatedToPatchRelay: false,
        appliedDelegatedToPatchRelay: true,
        hydration: "live_linear_failed",
        decision: "none",
        reason: "preserved_previous_delegation_after_live_linear_failed",
      },
    });
    appendRunReleasedAuthorityEvent(db, {
      projectId: "usertold",
      linearIssueId: "issue-audit",
      payload: {
        runId: 42,
        runType: "implementation",
        localDelegatedToPatchRelay: false,
        liveDelegatedToPatchRelay: false,
        source: "run_reconciler",
        reason: "Issue was un-delegated during active run",
      },
    });

    const data = new CliDataAccess(config, { db });
    const audit = data.audit("USE-77");
    assert.ok(audit);
    assert.equal(audit.events.length, 2);
    assert.match(formatAudit(audit), /preserved_previous_delegation_after_live_linear_failed/);
    assert.match(formatAudit(audit), /released run #42 \(implementation\)/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
