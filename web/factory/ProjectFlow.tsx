import { useState } from "react";
import type { FactoryProject, FactoryTask, Station } from "../../src/factory/types.ts";

const stages: { id: Station; label: string; detail: string }[] = [
  { id: "intake", label: "Intake", detail: "Waiting to start" },
  { id: "implementation", label: "Implementation", detail: "Building and repairing" },
  { id: "review", label: "Review", detail: "Checking the change" },
  { id: "queue", label: "Merge queue", detail: "Waiting to merge" },
  { id: "main", label: "Main", detail: "Merged changes" },
];
const signals = { active: "Working", waiting: "Waiting", attention: "Needs attention", complete: "Complete" };

export function ProjectFlow({ project, selectedId, onSelect, attention, query, onBack }: {
  project: FactoryProject;
  selectedId: string | null;
  onSelect: (task: FactoryTask) => void;
  attention: boolean;
  query: string;
  onBack: () => void;
}) {
  const [limits, setLimits] = useState<Partial<Record<Station, number>>>({});
  const filtered = project.tasks.filter(t => (!attention || t.signal === "attention") && `${t.key} ${t.title}`.toLowerCase().includes(query.toLowerCase()));
  const repairs = filtered.filter(t => t.repairing).length;
  return <section className="project-flow" aria-label={`${project.name} workflow`}>
    <div className="flow-heading">
      <button onClick={onBack} aria-label="Fit all projects">← All projects</button>
      <h2>{project.name}</h2>
      <p>Follow the numbered stages. Select a task for its review, checks, and queue status.</p>
      {repairs > 0 && <p className="flow-repairs">↶ {repairs} {repairs === 1 ? "task is" : "tasks are"} back in implementation for repairs.</p>}
    </div>
    <div className="flow-columns">
      {stages.map((stage, index) => {
        const tasks = filtered.filter(t => t.station === stage.id).sort((a, b) =>
          (stage.id === "queue" ? (a.queue?.position ?? Infinity) - (b.queue?.position ?? Infinity) : 0) ||
          b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
        const limit = limits[stage.id] ?? 20;
        return <section className="flow-lane" key={stage.id} aria-label={stage.label}>
          <header className="flow-stage">
            <span className="flow-step">{index + 1}</span>
            <h3>{stage.label} <small>{tasks.length}</small></h3>
            <p>{stage.detail}</p>
          </header>
          <div className="flow-tasks">
            {tasks.length === 0 && <p className="flow-empty">{attention || query ? "No matching tasks" : "No tasks here"}</p>}
            {tasks.slice(0, limit).map(task => <button key={task.id}
              className={`flow-task ${selectedId === task.id ? "flow-selected" : ""}`}
              aria-label={`${task.key}: ${task.title}, ${stage.label}`}
              aria-pressed={selectedId === task.id} onClick={() => onSelect(task)}>
              <span className="flow-task-meta"><b>{task.key}</b>{task.queue?.position !== undefined && <span>#{task.queue.position} in queue</span>}</span>
              <span className="flow-task-title">{task.title}</span>
              <span className={`flow-signal signal-${task.signal}`}>{task.repairing ? "↶ Repairing" : signals[task.signal]}</span>
            </button>)}
            {tasks.length > limit && <button className="flow-more" onClick={() => setLimits(l => ({ ...l, [stage.id]: limit + 20 }))}>Show more · {tasks.length - limit} remaining</button>}
          </div>
        </section>;
      })}
    </div>
  </section>;
}
