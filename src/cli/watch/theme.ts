// ─── Factory State Colors ─────────────────────────────────────────

export const FACTORY_STATE_COLORS: Record<string, string> = {
  delegated: "blue",
  implementing: "yellow",
  awaiting_input: "yellow",
  pr_open: "cyan",
  changes_requested: "magenta",
  repairing_ci: "magenta",
  repairing_queue: "magenta",
  awaiting_queue: "green",
  done: "green",
  failed: "red",
  escalated: "red",
};

// ─── Item Status Symbols & Colors ─────────────────────────────────

export const ITEM_STATUS_SYMBOLS: Record<string, string> = {
  completed: "\u2713",
  failed: "\u2717",
  declined: "\u2717",
  inProgress: "\u25cf",
};

export const ITEM_STATUS_COLORS: Record<string, string> = {
  completed: "green",
  failed: "red",
  declined: "red",
  inProgress: "yellow",
};

// ─── CI Check Symbols & Colors ────────────────────────────────────

export const CHECK_SYMBOLS: Record<string, string> = {
  passed: "\u2713",
  failed: "\u2717",
  pending: "\u25cf",
};

export const CHECK_COLORS: Record<string, string> = {
  passed: "green",
  failed: "red",
  pending: "yellow",
};

// ─── Feed Event Colors ────────────────────────────────────────────

export const FEED_LEVEL_COLORS: Record<string, string> = {
  info: "white",
  warn: "yellow",
  error: "red",
};

export const FEED_KIND_COLORS: Record<string, string> = {
  stage: "cyan",
  turn: "yellow",
  github: "green",
  webhook: "blue",
  agent: "magenta",
  service: "white",
  workflow: "cyan",
  linear: "blue",
};
