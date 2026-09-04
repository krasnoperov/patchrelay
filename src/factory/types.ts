export type Station = "intake" | "implementation" | "review" | "queue" | "main";
export type Signal = "active" | "waiting" | "complete" | "attention";

export interface FactoryTask {
  id: string;
  projectId: string;
  key: string;
  title: string;
  station: Station;
  signal: Signal;
  phase: string;
  updatedAt: string;
  paused: boolean;
  repairing: boolean;
  note?: string;
  issueKey?: string;
  prNumber?: number;
  prUrl?: string;
  headSha?: string;
  agent?: string;
  review?: string;
  queue?: { status: string; position: number; headSha: string };
  checks?: { passed: number; failed: number; pending: number; total: number };
}

export interface FactoryProject {
  id: string;
  name: string;
  repo?: string;
  tasks: FactoryTask[];
}

export interface FactorySource {
  id: string;
  name: string;
  state: "connected" | "unavailable" | "unconfigured" | "observed";
  detail: string;
}

export interface FactorySnapshot {
  generatedAt: string;
  projects: FactoryProject[];
  sources: FactorySource[];
}
