import { useEffect, useState } from "react";
import type { FactoryTask } from "../../src/factory/types.ts";
import { stationLabels } from "./World.tsx";

interface Detail {
  issueContext?: {
    issueUrl?: string;
    branchName?: string;
    latestFailureSummary?: string;
  };
  runs?: {
    runType: string;
    status: string;
    report?: { latestAssistantMessage?: string };
  }[];
}
const human = (value: string) => value.replaceAll("_", " ");
function externalUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function Inspector({
  task,
  tasks,
  onSelect,
  token,
  demo,
  onClose,
}: {
  task: FactoryTask | undefined;
  tasks: FactoryTask[];
  onSelect: (task: FactoryTask) => void;
  token: string;
  demo: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailState, setDetailState] = useState("idle");
  useEffect(() => {
    setDetail(null);
    if (demo || !task?.issueKey) {
      setDetailState("idle");
      return;
    }
    const controller = new AbortController();
    setDetailState("loading");
    fetch(`/api/issues/${encodeURIComponent(task.issueKey)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error("Detail unavailable");
        return r.json() as Promise<Detail>;
      })
      .then((value) => {
        setDetail(value);
        setDetailState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setDetailState("error");
      });
    return () => controller.abort();
  }, [task?.id, task?.updatedAt, token, demo]);
  const issueUrl = externalUrl(detail?.issueContext?.issueUrl);
  const prUrl = externalUrl(task?.prUrl);
  return (
    <aside
      className={`inspector ${task ? "inspector-open" : ""}`}
      aria-label="Task inspector"
    >
      <div className="panel-heading">
        TASK INSPECTOR
        <button aria-label="Close inspector" onClick={onClose}>
          ×
        </button>
      </div>
      {task ? (
        <>
          <div className="inspector-intro">
            <div className={`task-id signal-${task.signal}`}>
              <span>◇</span> {task.key}
              <span className="issue-kind">
                {task.prNumber ? `PR #${task.prNumber}` : "ISSUE"}
              </span>
            </div>
            <h2>{task.title}</h2>
            <span className={`state-badge signal-${task.signal}`}>
              {task.signal === "attention"
                ? "⚠"
                : task.signal === "complete"
                  ? "✓"
                  : "●"}{" "}
              {stationLabels[task.station]}
              {task.repairing ? " · repair" : ""}
            </span>
          </div>
          <section className="inspector-section">
            <h3>On the circuit</h3>
            <div className="journey">
              {["implementation", "review", "queue", "main"].map((stage, i) => (
                <div
                  key={stage}
                  className={task.station === stage ? "journey-current" : ""}
                >
                  <span>{i + 1}</span>
                  <small>{["Build", "Review", "Queue", "Main"][i]}</small>
                </div>
              ))}
            </div>
            {task.note && (
              <p
                className={`task-note ${task.signal === "attention" ? "note-attention" : ""}`}
              >
                {task.note}
              </p>
            )}
          </section>
          <section className="inspector-section">
            <h3>Current observations</h3>
            <dl>
              <dt>Workflow</dt>
              <dd>{human(task.phase)}</dd>
              <dt>Agent</dt>
              <dd>
                {task.paused
                  ? "Paused"
                  : task.agent
                    ? human(task.agent)
                    : "No active run"}
              </dd>
              <dt>Review</dt>
              <dd>{task.review ? human(task.review) : "Not observed"}</dd>
              <dt>Queue</dt>
              <dd>
                {task.queue
                  ? `${human(task.queue.status)} · ${task.queue.position}`
                  : "Position unknown"}
              </dd>
              {task.headSha && (
                <>
                  <dt>PR head</dt>
                  <dd>
                    <code>{task.headSha.slice(0, 8)}</code>
                  </dd>
                </>
              )}
            </dl>
          </section>
          <section className="inspector-section">
            <h3>
              Checks{" "}
              <span>
                {task.checks
                  ? `${task.checks.passed} / ${task.checks.total}`
                  : "—"}
              </span>
            </h3>
            {task.checks ? (
              <>
                <div className="check-bar">
                  {Array.from(
                    { length: Math.min(task.checks.total, 30) },
                    (_, i) => (
                      <span
                        key={i}
                        className={
                          i < task.checks!.passed
                            ? "check-passed"
                            : i < task.checks!.passed + task.checks!.failed
                              ? "check-failed"
                              : "check-pending"
                        }
                      />
                    ),
                  )}
                </div>
                <p className="check-caption">
                  {task.checks.passed} passed · {task.checks.failed} failed ·{" "}
                  {task.checks.pending} pending
                </p>
              </>
            ) : (
              <p className="muted">No check results observed.</p>
            )}
            {task.station === "main" && (
              <p className="muted">
                Merged into main. Deployment is tracked separately.
              </p>
            )}
          </section>
          <section className="inspector-section">
            <h3>Latest activity</h3>
            <p className="activity-note">
              {detail?.runs?.at(-1)?.report?.latestAssistantMessage ??
                (demo
                  ? "Sample activity. Connect the live factory to see agent reports."
                  : detailState === "loading"
                    ? "Loading issue activity…"
                    : detailState === "error"
                      ? "Issue detail is unavailable. The world still shows the last snapshot."
                      : (task.note ?? "No agent report available."))}
            </p>
            <div className="task-links">
              {issueUrl && (
                <a href={issueUrl} target="_blank" rel="noreferrer">
                  Open issue ↗
                </a>
              )}
              {prUrl && (
                <a href={prUrl} target="_blank" rel="noreferrer">
                  Open PR ↗
                </a>
              )}
            </div>
          </section>
        </>
      ) : (
        <div className="inspector-empty">
          <span>⌖</span>
          <h2>Follow the work.</h2>
          <p>
            Select a task on the circuit to see its agent, review, checks, and
            queue position.
          </p>
        </div>
      )}
      <section className="inspector-section task-directory">
        <h3>
          {"Task directory"}
          <span>{tasks.length}</span>
        </h3>
        {tasks.map((t) => (
          <button
            key={t.id}
            className={task?.id === t.id ? "directory-selected" : ""}
            onClick={() => onSelect(t)}
          >
            <span className={`signal-${t.signal}`}>
              {t.signal === "attention"
                ? "⚠"
                : t.signal === "complete"
                  ? "✓"
                  : "●"}
            </span>
            <b>{t.key}</b>
            <small>{t.title}</small>
          </button>
        ))}
      </section>
    </aside>
  );
}
