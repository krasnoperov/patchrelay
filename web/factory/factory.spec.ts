import { test, expect } from "@playwright/test";
import { createDemo } from "./demo.ts";

test("explore projects, inspect and move a task, filter, zoom, and pause", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/factory?demo=1");
  await expect(
    page.getByRole("heading", { name: "Work, in motion." }),
  ).toBeVisible();
  await expect(page.locator(".project-cell")).toHaveCount(4);
  await page
    .getByRole("button", {
      name: "PR-143: Recover interrupted runs, Implementation",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Recover interrupted runs" }),
  ).toBeVisible();
  await expect(page.locator(".note-attention")).toContainText(
    "repairing the retry path",
  );
  await page.getByRole("button", { name: "Needs me", exact: false }).click();
  await expect(page.locator(".task-dim")).toHaveCount(20);
  await page.getByRole("button", { name: "Needs me", exact: false }).click();
  await page.getByRole("textbox", { name: "Search tasks" }).fill("retry");
  await expect(page.locator(".task-dim")).not.toHaveCount(0);
  await page.getByRole("textbox", { name: "Search tasks" }).fill("");
  await page
    .getByRole("button", { name: "Focus PatchRelay", exact: true })
    .click();
  await expect(page.locator(".project-flow")).toBeVisible();
  await expect(page.locator(".project-flow")).toContainText("Build the factory world");
  await page
    .getByRole("button", { name: "Fit all projects", exact: true })
    .click();
  await expect(page.locator(".world-caption")).toContainText("WORLD VIEW");
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect(page.locator(".task-token")).toHaveCount(0);
  await expect(page.locator(".compact-cell")).toHaveCount(4);
  await page.getByRole("button", { name: "Fit all projects", exact: true }).click();
  await page
    .getByRole("button", { name: "Pause motion", exact: false })
    .click();
  await expect(page.locator(".world")).toHaveClass(/motion-paused/);
  await page
    .getByRole("button", { name: "Advance PR-142", exact: false })
    .click();
  await expect(
    page.getByRole("button", {
      name: "PR-142: Build the factory world, Review",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "PR-142: Build the factory world, Review",
      exact: true,
    })
    .click();
  await expect(page.locator(".state-badge")).toContainText("Review");
  expect(errors).toEqual([]);
});

test("real stream snapshots update the world without demo fallback", async ({
  page,
}) => {
  const snapshot = createDemo();
  snapshot.projects = snapshot.projects.slice(0, 1);
  snapshot.projects[0]!.name = "Live fixture";
  await page.route("**/api/factory/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(snapshot)}\n\n`,
    }),
  );
  await page.goto("/factory");
  await expect(page.locator(".cell-title")).toHaveText("Live fixture");
  await expect(page.locator(".demo-strip")).toHaveCount(0);
  // A closed stream retains the last world and visibly marks it stale.
  await expect(page.getByRole("alert")).toContainText("Connection interrupted");
  await expect(page.locator(".world")).toHaveClass(/motion-paused/);
});

test("operator auth and disabled API states", async ({ page }) => {
  await page.route("**/api/factory/stream", (route) =>
    route.fulfill({ status: 401, body: "{}" }),
  );
  await page.goto("/factory");
  await expect(
    page.getByRole("heading", { name: "Connect to your factory" }),
  ).toBeVisible();
  await page.getByLabel("Operator token").fill("test-token");
  await page.unroute("**/api/factory/stream");
  await page.route("**/api/factory/stream", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer test-token");
    await route.fulfill({ status: 404, body: "{}" });
  });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Operator API is disabled" }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test("desktop and mobile browser screenshots and usable inspector", async ({
  page,
}) => {
  await page.goto("/factory?demo=1");
  await expect(page.locator(".project-cell")).toHaveCount(4);
  await page.screenshot({ path: "/tmp/patchrelay-factory-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(page.locator(".world")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page
    .getByRole("button", { name: "Map: PatchRelay", exact: true })
    .click();
  await page.screenshot({ path: "/tmp/patchrelay-factory-mobile.png" });
  await page
    .getByRole("button", {
      name: "PR-143: Recover interrupted runs, Implementation",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Recover interrupted runs" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/patchrelay-factory-mobile-inspector.png",
  });
});


test("drag release and cancellation do not crash queued camera updates", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/factory?demo=1");
  const world = page.locator(".world-svg");
  const box = (await world.boundingBox())!;
  const before = await world.getAttribute("viewBox");
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 75, box.y + 45, { steps: 8 });
  await page.mouse.up();
  await expect(world).not.toHaveAttribute("viewBox", before!);
  // Release in the same browser turn as movement: React may defer the updater.
  await world.evaluate(el => {
    for (let i = 0; i < 30; i++) {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }));
      el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 50, clientY: 50 }));
      el.dispatchEvent(new PointerEvent(i % 2 ? "pointerup" : "pointercancel", { bubbles: true, pointerId: 1 }));
    }
  });
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.locator(".map-tools")).toContainText("125%");
  expect(errors).toEqual([]);
});

test("project flow shows task meaning and filters across stages", async ({ page }) => {
  await page.goto("/factory?demo=1");
  await page.getByRole("button", { name: "Focus PatchRelay", exact: true }).click();
  await expect(page.locator(".flow-stage")).toHaveCount(5);
  await expect(page.locator(".chip-shell")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search tasks" }).fill("no such task");
  await expect(page.locator(".flow-task")).toHaveCount(0);
  await expect(page.locator(".flow-empty")).toHaveCount(5);
  await page.getByRole("textbox", { name: "Search tasks" }).fill("");
  await page.screenshot({ path: "/tmp/patchrelay-project-flow-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.screenshot({ path: "/tmp/patchrelay-project-flow-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
