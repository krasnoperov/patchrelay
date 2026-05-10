import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { buildIssueTriageHash, IssueTriageService } from "../src/issue-triage.ts";

test("issue triage parses JSON from a cheap app-server thread", async () => {
  let capturedPrompt = "";
  const service = new IssueTriageService({
    async startThreadForIssueTriage() {
      return { id: "triage-thread-1", preview: "", cwd: "/tmp/triage", status: "idle", turns: [] };
    },
    async startTurn(options) {
      capturedPrompt = options.input;
      return { threadId: options.threadId, turnId: "triage-turn-1", status: "running" };
    },
    async readThread() {
      return {
        id: "triage-thread-1",
        preview: "",
        cwd: "/tmp/triage",
        status: "idle",
        turns: [
          {
            id: "triage-turn-1",
            status: "completed",
            items: [
              {
                id: "msg-1",
                type: "agentMessage",
                text: '{"issueClass":"orchestration","intent":"split_into_children","confidence":0.91,"reason":"The issue asks the worker to split broad work into child issues."}',
              },
            ],
          },
        ],
      };
    },
  }, pino({ enabled: false }));

  const result = await service.classify({
    issue: {
      linearIssueId: "issue-lsr-367",
      issueKey: "LSR-367",
      title: "Break this migration into sub-issues",
      description: "Create the child tasks and coordinate the rollout.",
    },
    childIssues: [],
  });

  assert.equal(result?.issueClass, "orchestration");
  assert.equal(result?.intent, "split_into_children");
  assert.match(capturedPrompt, /Do not solve the task, decompose the work, create a plan, or propose child issue titles\./);
  assert.match(capturedPrompt, /Return exactly one JSON object and no extra prose\./);
});

test("issue triage keeps polling while the app-server thread materializes", async () => {
  let readCount = 0;
  const service = new IssueTriageService({
    async startThreadForIssueTriage() {
      return { id: "triage-thread-2", preview: "", cwd: "/tmp/triage", status: "idle", turns: [] };
    },
    async startTurn(options) {
      return { threadId: options.threadId, turnId: "triage-turn-2", status: "running" };
    },
    async readThread() {
      readCount += 1;
      if (readCount === 1) {
        throw new Error("thread not materialized yet");
      }
      return {
        id: "triage-thread-2",
        preview: "",
        cwd: "/tmp/triage",
        status: "idle",
        turns: [
          {
            id: "triage-turn-2",
            status: "completed",
            items: [
              {
                id: "msg-2",
                type: "agentMessage",
                text: '{"issueClass":"orchestration","intent":"coordination","confidence":0.86,"reason":"The issue needs parent-level coordination before implementation."}',
              },
            ],
          },
        ],
      };
    },
  }, pino({ enabled: false }));

  const result = await service.classify({
    issue: {
      linearIssueId: "issue-lsr-368",
      issueKey: "LSR-368",
      title: "Coordinate the migration",
      description: "Inspect the parent state and decide child work.",
    },
    childIssues: [],
  });

  assert.equal(readCount, 2);
  assert.equal(result?.issueClass, "orchestration");
  assert.equal(result?.intent, "coordination");
});

test("issue triage hash changes when the issue text changes", () => {
  const base = {
    issue: {
      linearIssueId: "issue-1",
      issueKey: "LSR-1",
      title: "Initial title",
      description: "Initial description",
    },
    childIssues: [],
  };

  assert.notEqual(
    buildIssueTriageHash(base),
    buildIssueTriageHash({
      ...base,
      issue: {
        ...base.issue,
        description: "Updated description",
      },
    }),
  );
});
