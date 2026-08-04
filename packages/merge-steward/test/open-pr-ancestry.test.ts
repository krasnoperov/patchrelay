import assert from "node:assert/strict";
import git from "isomorphic-git";
import test from "node:test";
import { findUnlandedOpenPrAncestors } from "../src/open-pr-ancestry.ts";
import type { GitHubPRApi, GitOperations } from "../src/interfaces.ts";
import { createHarness } from "./harness.ts";

function graph(relationships: string[], mergeBases: Record<string, string>): GitOperations {
  const ancestors = new Set(relationships);
  return {
    async fetch() {},
    async headSha(branch) { return branch; },
    async mergeBase(left, right) {
      return mergeBases[`${left}|${right}`] ?? left;
    },
    async isAncestor(ancestor, descendant) {
      return ancestor === descendant || ancestors.has(`${ancestor}|${descendant}`);
    },
    async push() {},
  };
}

function openPrApi(prs: Array<{ number: number; branch: string; headSha: string }>): GitHubPRApi {
  return {
    async listOpenPRs() { return prs; },
  } as GitHubPRApi;
}

test("finds shared open-PR history absent from current main after the parent advances", async () => {
  const blockers = await findUnlandedOpenPrAncestors({
    github: openPrApi([
      { number: 10, branch: "already-landed", headSha: "landed" },
      { number: 20, branch: "blocked-parent", headSha: "blocked" },
      { number: 30, branch: "candidate", headSha: "candidate" },
      { number: 40, branch: "independent", headSha: "independent" },
      { number: 50, branch: "declared-child", headSha: "descendant" },
    ]),
    git: graph([
      "landed|main",
      "candidate|descendant",
    ], {
      "landed|candidate": "landed",
      "blocked|candidate": "blocked-v1",
      "independent|candidate": "main",
      "descendant|candidate": "candidate",
    }),
    currentPrNumber: 30,
    prHeadSha: "candidate",
    candidateSha: "candidate",
    baseSha: "main",
  });

  assert.deepEqual(blockers, [{
    prNumber: 20,
    branch: "blocked-parent",
    headSha: "blocked",
    sharedAncestorSha: "blocked-v1",
  }]);
});

test("evicts a hidden stack before candidate selection", async () => {
  const h = await createHarness({ ciRule: () => "pass" });
  await h.gitSim.createBranch("blocked-parent", "main");
  await git.checkout({
    fs: h.gitSim.volume,
    dir: h.gitSim.repoDir,
    ref: "blocked-parent",
    force: true,
  });
  await h.gitSim.commitFile("oauth.ts", "blocked", "blocked parent change");
  await git.checkout({
    fs: h.gitSim.volume,
    dir: h.gitSim.repoDir,
    ref: "main",
    force: true,
  });
  const blockedHead = await h.gitSim.headSha("blocked-parent");
  h.githubSim.addPR({
    number: 1028,
    branch: "blocked-parent",
    headSha: blockedHead,
    baseRefName: "main",
    reviewApproved: false,
  });

  const child = await h.enqueue({
    number: 1030,
    branch: "hidden-child",
    baseRefName: "blocked-parent",
    files: [{ path: "activation.ts", content: "activation" }],
  });
  h.githubSim.setBaseRef(1030, "main");
  h.store.updateBaseRef(child.id, "main", "simulate PR declared against main");

  await h.tick();
  await h.tick();

  const evicted = h.entries.find((entry) => entry.prNumber === 1030)!;
  assert.equal(evicted.status, "evicted");
  assert.equal(evicted.candidateSha, null);
  assert.equal(h.evictions[0]?.incident.failureClass, "policy_blocked");
  assert.deepEqual(h.evictions[0]?.incident.context.openPrAncestors, [{
    prNumber: 1028,
    branch: "blocked-parent",
    headSha: blockedHead,
    sharedAncestorSha: blockedHead,
  }]);
  assert.equal(await h.gitSim.isAncestor(blockedHead, await h.gitSim.headSha("main")), false);
});

test("rechecks open PR ancestry immediately before the fast-forward push", async () => {
  const h = await createHarness({ ciRule: () => "pass" });
  const candidate = await h.enqueue({
    number: 1030,
    branch: "candidate",
    files: [{ path: "activation.ts", content: "activation" }],
  });

  await h.tick();
  await h.tick();
  await h.tick();
  assert.equal(h.entries[0]?.status, "merging");

  const originalGetStatus = h.githubSim.getStatus.bind(h.githubSim);
  let landingStatusReads = 0;
  h.githubSim.getStatus = async (prNumber: number) => {
    landingStatusReads += 1;
    if (landingStatusReads === 3) {
      h.githubSim.addPR({
        number: 1028,
        branch: "late-open-parent",
        headSha: candidate.headSha,
        baseRefName: "main",
        reviewApproved: false,
      });
    }
    return await originalGetStatus(prNumber);
  };
  await h.tick();

  assert.equal(landingStatusReads, 3);
  assert.equal(h.entries.find((entry) => entry.prNumber === 1030)?.status, "evicted");
  assert.deepEqual(h.evictions[0]?.incident.context.openPrAncestors, [{
    prNumber: 1028,
    branch: "late-open-parent",
    headSha: candidate.headSha,
    sharedAncestorSha: candidate.headSha,
  }]);
  assert.equal(await h.gitSim.isAncestor(candidate.headSha, await h.gitSim.headSha("main")), false);
});
