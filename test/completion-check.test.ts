import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { CompletionCheckService, extractCompletionCheck } from "../src/completion-check.ts";

test("completion check parses wrapped JSON from the forked thread", async () => {
  let capturedPrompt = "";
  const service = new CompletionCheckService({
    async forkThreadForCompletionCheck() {
      return { id: "fork-1", preview: "", cwd: "/tmp/completion-check", status: "idle", turns: [] };
    },
    async startTurn(options) {
      capturedPrompt = options.input;
      return { threadId: "fork-1", turnId: "turn-1", status: "running" };
    },
    async readThread() {
      return {
        id: "fork-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "msg-1",
                type: "agentMessage",
                text: [
                  "Here is the result:",
                  '{"outcome":"needs_input","summary":"Approval required before continuing.","question":"Approve the routing change?","why":"The asset still bypasses the worker.","recommendedReply":"Approved: update the routing."}',
                ].join("\n"),
              },
            ],
          },
        ],
      };
    },
  }, pino({ enabled: false }));

  const result = await service.run({
    issue: {
      issueKey: "USE-110",
      linearIssueId: "issue-use-110",
      title: "Harden worker security headers",
      description: "Add the baseline headers everywhere.",
      worktreePath: "/tmp/work",
    },
    run: {
      id: 1,
      threadId: "thread-1",
      runType: "implementation",
    },
    noPrSummary: "Implementation completed without opening a PR.",
  });

  assert.equal(result.outcome, "needs_input");
  assert.equal(result.question, "Approve the routing change?");
  assert.equal(result.recommendedReply, "Approved: update the routing.");
  assert.equal(result.threadId, "fork-1");
  assert.equal(result.turnId, "turn-1");
  assert.match(capturedPrompt, /Do not run commands, call tools, edit files, or inspect the repository\./);
  assert.match(capturedPrompt, /Return exactly one JSON object and no extra prose\./);
});

test("completion check falls back to failed when the fork result is not valid JSON", async () => {
  const service = new CompletionCheckService({
    async forkThreadForCompletionCheck() {
      return { id: "fork-2", preview: "", cwd: "/tmp/completion-check", status: "idle", turns: [] };
    },
    async startTurn() {
      return { threadId: "fork-2", turnId: "turn-2", status: "running" };
    },
    async readThread() {
      return {
        id: "fork-2",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-2",
            status: "completed",
            items: [{ id: "msg-2", type: "agentMessage", text: "I think this should continue." }],
          },
        ],
      };
    },
  }, pino({ enabled: false }));

  const result = await service.run({
    issue: {
      issueKey: "USE-111",
      linearIssueId: "issue-use-111",
      title: "Harden worker security headers",
      description: undefined,
      worktreePath: "/tmp/work",
    },
    run: {
      id: 2,
      threadId: "thread-2",
      runType: "implementation",
    },
    noPrSummary: "Implementation completed without opening a PR.",
  });

  assert.equal(result.outcome, "failed");
  assert.match(result.summary, /invalid result/i);
});

test("extractCompletionCheck reads persisted typed fields from a run", () => {
  const result = extractCompletionCheck({
    completionCheckOutcome: "done",
    completionCheckSummary: "Created the follow-up Linear issues and no PR was needed.",
    completionCheckQuestion: undefined,
    completionCheckWhy: undefined,
    completionCheckRecommendedReply: undefined,
  });

  assert.deepEqual(result, {
    outcome: "done",
    summary: "Created the follow-up Linear issues and no PR was needed.",
  });
});
