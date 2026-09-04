import type {
  FactorySnapshot,
  FactoryTask,
  Station,
} from "../../src/factory/types.ts";

const names = ["PatchRelay", "UserTold", "MakeFX", "Platform"];
const titles = [
  [
    "Build the factory world",
    "Recover interrupted runs",
    "Preserve review context",
    "Improve queue visibility",
    "Show agent activity",
    "Handle webhook retries",
    "Simplify issue navigation",
  ],
  [
    "Add interview highlights",
    "Refine consent flow",
    "Export research evidence",
    "Improve study onboarding",
    "Connect findings to work",
  ],
  [
    "Keep character references",
    "Add collection previews",
    "Render audio waveforms",
    "Improve asset search",
    "Save generation presets",
  ],
  [
    "Stream service events",
    "Rotate runtime credentials",
    "Add health observations",
    "Reduce build latency",
  ],
];
const stations: Station[][] = [
  [
    "implementation",
    "implementation",
    "review",
    "queue",
    "queue",
    "intake",
    "main",
  ],
  ["implementation", "review", "review", "queue", "main"],
  ["implementation", "implementation", "review", "queue", "main"],
  ["implementation", "review", "queue", "main"],
];

export function createDemo(): FactorySnapshot {
  return {
    generatedAt: new Date().toISOString(),
    projects: names.map((name, p) => ({
      id: name.toLowerCase(),
      name,
      repo: `demo/${name.toLowerCase()}`,
      tasks: (titles[p] ?? []).map((title, i): FactoryTask => ({
        id: `${p}-${i}`,
        projectId: name.toLowerCase(),
        key: `${["PR", "USE", "FX", "OPS"][p]}-${142 + i}`,
        title,
        station: stations[p]?.[i] ?? "intake",
        phase:
          i === 1 && p === 0
            ? "changes_requested"
            : {
                intake: "delegated",
                implementation: "implementing",
                review: "pr_open",
                queue: "awaiting_queue",
                main: "done",
              }[stations[p]?.[i] ?? "intake"],
        signal:
          i === 1 && p === 0
            ? "attention"
            : stations[p]?.[i] === "main"
              ? "complete"
              : i === 0
                ? "active"
                : "waiting",
        paused: false,
        repairing: i === 1 && p === 0,
        updatedAt: new Date().toISOString(),
        prNumber: 380 + p * 10 + i,
        headSha: `a71c${p}${i}9e`,
        agent: i < 2 ? "implementation" : undefined,
        review:
          stations[p]?.[i] === "queue"
            ? "approved"
            : i === 1 && p === 0
              ? "changes_requested"
              : "pending",
        checks: {
          passed: i === 1 && p === 0 ? 3 : 5,
          failed: i === 1 && p === 0 ? 1 : 0,
          pending: i === 0 ? 1 : 0,
          total: i === 0 ? 6 : i === 1 && p === 0 ? 4 : 5,
        },
        queue:
          stations[p]?.[i] === "queue"
            ? {
                status: "queued",
                position: i - (p === 0 ? 2 : p === 3 ? 1 : 2),
                headSha: `a71c${p}${i}9e`,
              }
            : undefined,
        note:
          i === 1 && p === 0
            ? "Review requested changes. Agent is repairing the retry path before submitting a new head."
            : undefined,
      })),
    })),
    sources: [
      "PatchRelay",
      "Linear",
      "GitHub / CI",
      "Review-quill",
      "Merge-steward",
    ].map((name, i) => ({
      id: String(i),
      name,
      state: "observed",
      detail: "Illustrative demo data — no live service connection",
    })),
  };
}

export function advanceDemo(snapshot: FactorySnapshot): FactorySnapshot {
  const order: Station[] = [
    "intake",
    "implementation",
    "review",
    "queue",
    "main",
  ];
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    projects: snapshot.projects.map((project, index) => ({
      ...project,
      tasks: project.tasks.map((task, i) => {
        if (index !== 0 || i !== 0) return task;
        const station =
          order[(order.indexOf(task.station) + 1) % order.length]!;
        return {
          ...task,
          station,
          signal: station === "main" ? "complete" : "active",
          phase: station === "main" ? "done" : station,
          review:
            station === "queue" || station === "main" ? "approved" : "pending",
          queue:
            station === "queue"
              ? { status: "validating", position: 0, headSha: task.headSha! }
              : undefined,
        };
      }),
    })),
  };
}
