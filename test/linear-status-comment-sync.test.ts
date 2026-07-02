import assert from "node:assert/strict";
import { test } from "node:test";
import { collapseVisibleStatusComment } from "../src/linear-status-comment-sync.ts";

// Regression: collapsing an already-collapsed status comment must not write to
// Linear again. Every redundant write triggers a commentUpdated webhook echo,
// and any webhook-driven sync path then loops forever (USE-478 re-collapsed its
// placeholder every ~30-60s for two hours).

function makeLinearStub() {
  const calls: Array<{ commentId?: string; body: string }> = [];
  return {
    calls,
    client: {
      upsertIssueComment: async (params: { issueId: string; commentId?: string; body: string }) => {
        calls.push({ ...(params.commentId ? { commentId: params.commentId } : {}), body: params.body });
        return { id: params.commentId ?? "new-comment" };
      },
    },
  };
}

const silentLogger = {
  warn: () => {},
  info: () => {},
  debug: () => {},
  error: () => {},
} as never;

test("collapseVisibleStatusComment writes the placeholder once, then skips identical rewrites", async () => {
  const stub = makeLinearStub();
  const issue = {
    projectId: "p1",
    linearIssueId: "issue-collapse-idempotent",
    statusCommentId: "comment-collapse-idempotent",
  };

  await collapseVisibleStatusComment({ issue, linear: stub.client as never, logger: silentLogger });
  await collapseVisibleStatusComment({ issue, linear: stub.client as never, logger: silentLogger });
  await collapseVisibleStatusComment({ issue, linear: stub.client as never, logger: silentLogger });

  assert.equal(stub.calls.length, 1, "repeated collapse must not re-write the same body");
  assert.equal(stub.calls[0]?.commentId, "comment-collapse-idempotent");
});

test("collapseVisibleStatusComment still writes for a distinct comment id", async () => {
  const stub = makeLinearStub();
  const issueA = { projectId: "p1", linearIssueId: "issue-a", statusCommentId: "comment-distinct-a" };
  const issueB = { projectId: "p1", linearIssueId: "issue-b", statusCommentId: "comment-distinct-b" };

  await collapseVisibleStatusComment({ issue: issueA, linear: stub.client as never, logger: silentLogger });
  await collapseVisibleStatusComment({ issue: issueB, linear: stub.client as never, logger: silentLogger });

  assert.equal(stub.calls.length, 2, "different comments must each get their collapse write");
});
