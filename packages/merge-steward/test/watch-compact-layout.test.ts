import assert from "node:assert/strict";
import test from "node:test";
import type { DashboardModel, DashboardRepo } from "../src/watch/dashboard-model.ts";
import { stepRepo } from "../src/watch/dashboard-model.ts";
import { computeDashboardLayout, pickVisibleParts, renderOverviewLines } from "../src/watch/compact-layout.ts";

const NOW = Date.parse("2026-04-30T12:00:00.000Z");

function repo(index: number): DashboardRepo {
  return {
    repoId: `repo-${index}`,
    repoFullName: `owner/repo-${index}`,
    latestActivityAt: NOW,
    hasActivity: true,
    offlineMessage: null,
    entries: [],
    tokens: Array.from({ length: 8 }, (_, tokenIndex) => ({
      prNumber: index * 100 + tokenIndex + 1,
      glyph: tokenIndex === 0 ? "\u25cf" : "\u25cb",
      color: tokenIndex === 0 ? "yellow" : "gray",
      kind: tokenIndex === 0 ? "running" : "queued",
      eventAt: NOW - (tokenIndex + 1) * 60_000,
    })),
  };
}

function modelWithFourRepos(): DashboardModel {
  return {
    quietCount: 0,
    repos: [repo(1), repo(2), repo(3), repo(4)],
  };
}

function renderedRows(totalRows: number, selectedRepoId: string): string[] {
  const model = modelWithFourRepos();
  const layout = computeDashboardLayout(totalRows, false);
  return renderOverviewLines({
    model,
    selectedRepoId,
    showCursor: true,
    bodyRows: layout.bodyRows,
    topMarginRows: layout.bodyTopMarginRows,
    width: 100,
  });
}

test("merge-steward dashboard hides footer chrome on very small screens", () => {
  assert.deepEqual(computeDashboardLayout(4, true), {
    bodyRows: 3,
    bodyTopMarginRows: 0,
    showFlashMessage: false,
    showHelp: false,
  });
});

test("merge-steward dashboard restores help after the body keeps enough rows", () => {
  assert.deepEqual(computeDashboardLayout(8, false), {
    bodyRows: 4,
    bodyTopMarginRows: 1,
    showFlashMessage: false,
    showHelp: true,
  });
});

test("merge-steward repo visibility keeps the selected repo with a one-row body", () => {
  assert.deepEqual(pickVisibleParts(10, 5, 1), {
    start: 5,
    end: 6,
    showAbove: false,
    showBelow: false,
  });
});

test("merge-steward repo visibility reserves overflow indicators after the selected row", () => {
  assert.deepEqual(pickVisibleParts(10, 5, 3), {
    start: 5,
    end: 6,
    showAbove: true,
    showBelow: true,
  });
});

test("merge-steward tiny dashboard renders exact rows while moving down and up", () => {
  const originalNow = Date.now;
  Date.now = () => NOW;
  try {
    const model = modelWithFourRepos();
    const repo1 = "repo-1";
    const repo2 = stepRepo(model.repos, repo1, 1)!;
    const repo3 = stepRepo(model.repos, repo2, 1)!;

    assert.deepEqual(renderedRows(5, repo1), [
      "",
      "> owner/repo-1                  #101 \u25cf 1m  #102 \u25cb 2m  #103 \u25cb 3m  #104 \u25cb 4m  #105 \u25cb 5m  #106 \u25cb 6m",
      "  owner/repo-2                  #201 \u25cf 1m  #202 \u25cb 2m  #203 \u25cb 3m  #204 \u25cb 4m  #205 \u25cb 5m  #206 \u25cb 6m",
      "  \u21932 more below",
    ]);
    assert.deepEqual(renderedRows(5, repo2), [
      "",
      "  owner/repo-1                  #101 \u25cf 1m  #102 \u25cb 2m  #103 \u25cb 3m  #104 \u25cb 4m  #105 \u25cb 5m  #106 \u25cb 6m",
      "> owner/repo-2                  #201 \u25cf 1m  #202 \u25cb 2m  #203 \u25cb 3m  #204 \u25cb 4m  #205 \u25cb 5m  #206 \u25cb 6m",
      "  \u21932 more below",
    ]);
    assert.deepEqual(renderedRows(5, repo3), [
      "",
      "  \u21911 more above",
      "  owner/repo-2                  #201 \u25cf 1m  #202 \u25cb 2m  #203 \u25cb 3m  #204 \u25cb 4m  #205 \u25cb 5m  #206 \u25cb 6m",
      "> owner/repo-3                  #301 \u25cf 1m  #302 \u25cb 2m  #303 \u25cb 3m  #304 \u25cb 4m  #305 \u25cb 5m  #306 \u25cb 6m",
    ]);

    assert.deepEqual(renderedRows(4, repo1), [
      "> owner/repo-1                  #101 \u25cf 1m  #102 \u25cb 2m  #103 \u25cb 3m  #104 \u25cb 4m  #105 \u25cb 5m  #106 \u25cb 6m",
      "  owner/repo-2                  #201 \u25cf 1m  #202 \u25cb 2m  #203 \u25cb 3m  #204 \u25cb 4m  #205 \u25cb 5m  #206 \u25cb 6m",
      "  \u21932 more below",
    ]);
    assert.deepEqual(renderedRows(4, repo2), [
      "  owner/repo-1                  #101 \u25cf 1m  #102 \u25cb 2m  #103 \u25cb 3m  #104 \u25cb 4m  #105 \u25cb 5m  #106 \u25cb 6m",
      "> owner/repo-2                  #201 \u25cf 1m  #202 \u25cb 2m  #203 \u25cb 3m  #204 \u25cb 4m  #205 \u25cb 5m  #206 \u25cb 6m",
      "  \u21932 more below",
    ]);
    assert.deepEqual(renderedRows(4, repo3), [
      "  \u21911 more above",
      "  owner/repo-2                  #201 \u25cf 1m  #202 \u25cb 2m  #203 \u25cb 3m  #204 \u25cb 4m  #205 \u25cb 5m  #206 \u25cb 6m",
      "> owner/repo-3                  #301 \u25cf 1m  #302 \u25cb 2m  #303 \u25cb 3m  #304 \u25cb 4m  #305 \u25cb 5m  #306 \u25cb 6m",
    ]);

    assert.deepEqual(renderedRows(3, repo1), [
      "> owner/repo-1                  #101 \u25cf 1m  #102 \u25cb 2m  #103 \u25cb 3m  #104 \u25cb 4m  #105 \u25cb 5m  #106 \u25cb 6m",
      "  owner/repo-2                  #201 \u25cf 1m  #202 \u25cb 2m  #203 \u25cb 3m  #204 \u25cb 4m  #205 \u25cb 5m  #206 \u25cb 6m",
    ]);
    assert.deepEqual(renderedRows(3, repo2), [
      "  owner/repo-1                  #101 \u25cf 1m  #102 \u25cb 2m  #103 \u25cb 3m  #104 \u25cb 4m  #105 \u25cb 5m  #106 \u25cb 6m",
      "> owner/repo-2                  #201 \u25cf 1m  #202 \u25cb 2m  #203 \u25cb 3m  #204 \u25cb 4m  #205 \u25cb 5m  #206 \u25cb 6m",
    ]);
    assert.deepEqual(renderedRows(3, repo3), [
      "  owner/repo-2                  #201 \u25cf 1m  #202 \u25cb 2m  #203 \u25cb 3m  #204 \u25cb 4m  #205 \u25cb 5m  #206 \u25cb 6m",
      "> owner/repo-3                  #301 \u25cf 1m  #302 \u25cb 2m  #303 \u25cb 3m  #304 \u25cb 4m  #305 \u25cb 5m  #306 \u25cb 6m",
    ]);

    assert.deepEqual(renderedRows(5, stepRepo(model.repos, repo3, -1)!), renderedRows(5, repo2));
    assert.deepEqual(renderedRows(4, stepRepo(model.repos, repo3, -1)!), renderedRows(4, repo2));
    assert.deepEqual(renderedRows(3, stepRepo(model.repos, repo3, -1)!), renderedRows(3, repo2));
  } finally {
    Date.now = originalNow;
  }
});
