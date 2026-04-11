import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface CodexSessionSourceRecord {
  threadId: string;
  codexHome: string;
  sessionsDir: string;
  exists: boolean;
  path?: string;
  sessionId?: string;
  startedAt?: string;
  cwd?: string;
  originator?: string;
  error?: string;
}

interface ResolveCodexSessionSourceOptions {
  codexHome?: string;
}

interface SessionMetaPayload {
  id?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  originator?: unknown;
}

function resolveCodexHome(explicit?: string): string {
  return explicit
    ?? process.env.CODEX_HOME
    ?? path.join(homedir(), ".codex");
}

function walkSessionFiles(directory: string, threadId: string, matches: string[]): void {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkSessionFiles(fullPath, threadId, matches);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    if (entry.name.includes(threadId)) {
      matches.push(fullPath);
    }
  }
}

function readSessionMeta(filePath: string): { payload?: SessionMetaPayload; error?: string } {
  try {
    const firstLine = readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0];
    if (!firstLine) {
      return { error: "session file is empty" };
    }
    const parsed = JSON.parse(firstLine) as { type?: unknown; payload?: unknown };
    if (parsed.type !== "session_meta" || !parsed.payload || typeof parsed.payload !== "object" || Array.isArray(parsed.payload)) {
      return { error: "session file does not start with session_meta" };
    }
    return { payload: parsed.payload as SessionMetaPayload };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveCodexSessionSource(
  threadId: string,
  options?: ResolveCodexSessionSourceOptions,
): CodexSessionSourceRecord {
  const codexHome = resolveCodexHome(options?.codexHome);
  const sessionsDir = path.join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) {
    return {
      threadId,
      codexHome,
      sessionsDir,
      exists: false,
      error: `sessions directory not found: ${sessionsDir}`,
    };
  }

  const matches: string[] = [];
  walkSessionFiles(sessionsDir, threadId, matches);
  matches.sort().reverse();

  let firstError: string | undefined;
  for (const candidate of matches) {
    const { payload, error } = readSessionMeta(candidate);
    if (payload && payload.id === threadId) {
      return {
        threadId,
        codexHome,
        sessionsDir,
        exists: true,
        path: candidate,
        ...(typeof payload.id === "string" ? { sessionId: payload.id } : {}),
        ...(typeof payload.timestamp === "string" ? { startedAt: payload.timestamp } : {}),
        ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
        ...(typeof payload.originator === "string" ? { originator: payload.originator } : {}),
      };
    }
    if (!firstError && error) {
      firstError = `${candidate}: ${error}`;
    }
  }

  return {
    threadId,
    codexHome,
    sessionsDir,
    exists: false,
    ...(firstError ? { error: firstError } : { error: `session file not found for thread ${threadId}` }),
  };
}
