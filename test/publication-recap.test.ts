import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { PublicationRecapService } from "../src/publication-recap.ts";

test("publication recap parses wrapped JSON from the forked thread", async () => {
  let capturedPrompt = "";
  const service = new PublicationRecapService({
    async forkThreadForPublicationRecap() {
      return { id: "fork-1", preview: "", cwd: "/tmp/publication-recap", status: "idle", turns: [] };
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
                  "Here is the recap:",
                  '{"summary":"Addressed the requested review feedback and updated PR #42."}',
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
      issueKey: "USE-144",
      linearIssueId: "issue-use-144",
      title: "Keep publish comments concise",
      description: "Avoid boilerplate Linear comments.",
    },
    run: {
      id: 1,
      threadId: "thread-1",
      runType: "review_fix",
    },
    facts: {
      wakeReason: "review_changes_requested",
      reviewerName: "Ada",
      reviewSummary: "Please tighten the publish summary.",
      latestAssistantSummary: "I updated the PR and made the summary clearer.",
    },
  });

  assert.equal(result.summary, "Addressed the requested review feedback and updated PR #42.");
  assert.equal(result.threadId, "fork-1");
  assert.equal(result.turnId, "turn-1");
  assert.match(capturedPrompt, /one short sentence, max 30 words/);
  assert.match(capturedPrompt, /Do not list touched files, test commands, branch names, commit SHAs, or internal process details\./);
  assert.match(capturedPrompt, /Wake reason: review_changes_requested/);
  assert.match(capturedPrompt, /Latest assistant summary: I updated the PR and made the summary clearer\./);
});

test("publication recap fails when the fork result is not valid JSON", async () => {
  const service = new PublicationRecapService({
    async forkThreadForPublicationRecap() {
      return { id: "fork-2", preview: "", cwd: "/tmp/publication-recap", status: "idle", turns: [] };
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
            items: [{ id: "msg-2", type: "agentMessage", text: "This should probably say the PR was updated." }],
          },
        ],
      };
    },
  }, pino({ enabled: false }));

  await assert.rejects(
    () => service.run({
      issue: {
        issueKey: "USE-145",
        linearIssueId: "issue-use-145",
        title: "Keep publish comments concise",
        description: undefined,
      },
      run: {
        id: 2,
        threadId: "thread-2",
        runType: "implementation",
      },
    }),
    /invalid result/i,
  );
});
