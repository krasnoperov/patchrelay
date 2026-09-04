import { useRef, useState } from "react";
import { ProjectFlow } from "./ProjectFlow.tsx";
import type {
  FactoryProject,
  FactoryTask,
  Station,
} from "../../src/factory/types.ts";

const CELL_W = 590;
const CELL_H = 354;
const STEP_X = 630;
const STEP_Y = 406;
const stationX: Record<Station, number> = {
  intake: 26,
  implementation: 110,
  review: 255,
  queue: 400,
  main: 525,
};
const stages: Station[] = ["implementation", "review", "queue", "main"];
export const stationLabels: Record<Station, string> = {
  intake: "Intake",
  implementation: "Implementation",
  review: "Review",
  queue: "Merge queue",
  main: "Main",
};
export const palette = ["#a6bbd0", "#adb7c6", "#b8b5aa", "#a1b7bd"];
const glyphs = { active: "●", waiting: "○", complete: "✓", attention: "⚠" };

export function projectOrigin(index: number) {
  return {
    x: 35 + (index % 2) * STEP_X,
    y: 35 + Math.floor(index / 2) * STEP_Y,
  };
}

function ChipIcon({ stage }: { stage: Station }) {
  if (stage === "implementation")
    return (
      <>
        <path d="m-14 -8 -10 8 10 8m28-16 10 8-10 8M5-15-5 15" />
        <rect x="-34" y="-27" width="68" height="54" rx="10" />
      </>
    );
  if (stage === "review")
    return (
      <>
        <circle r="20" />
        <path d="m15 15 14 14m-40-29 8 8 14-16" />
      </>
    );
  if (stage === "queue")
    return (
      <>
        <rect x="-27" y="-21" width="54" height="42" rx="6" />
        <path d="M-16-9h32M-16 0h23M-16 9h14" />
      </>
    );
  return (
    <>
      <path d="m0-25 24 13v25L0 26-24 13v-25Zm0 26 24-13M0 1-24-13M0 1v25" />
      <circle cx="0" cy="-10" r="3" />
    </>
  );
}

function taskPositions(tasks: FactoryTask[]) {
  const result = new Map<string, { x: number; y: number; overflow: boolean }>();
  for (const stage of ["intake" as const, ...stages]) {
    const sorted = tasks
      .filter((t) => t.station === stage)
      .sort((a, b) => {
        if (stage === "queue")
          return (
            (a.queue?.position ?? Infinity) - (b.queue?.position ?? Infinity) ||
            a.key.localeCompare(b.key)
          );
        return a.key.localeCompare(b.key);
      });
    sorted.forEach((task, index) =>
      result.set(task.id, {
        x: stage === "intake" ? 28 : stationX[stage] - 42,
        y: stage === "intake" ? 297 : 229 + Math.min(index, 2) * 30,
        overflow: index > 2 || (stage === "intake" && index > 0),
      }),
    );
  }
  return result;
}

function ProjectCell({
  project,
  index,
  selectedId,
  onSelect,
  onFocus,
  attention,
  query,
  compact,
}: {
  project: FactoryProject;
  index: number;
  selectedId: string | null;
  onSelect: (task: FactoryTask) => void;
  onFocus: () => void;
  attention: boolean;
  query: string;
  compact: boolean;
}) {
  const origin = projectOrigin(index);
  const color = palette[index % palette.length];
  const positions = taskPositions(project.tasks);
  const visibleTasks = project.tasks.filter(
    (task) => !compact && !positions.get(task.id)?.overflow,
  );
  const matches = (task: FactoryTask) =>
    (!attention || task.signal === "attention") &&
    `${task.key} ${task.title}`.toLowerCase().includes(query.toLowerCase());
  return (
    <g
      transform={`translate(${origin.x} ${origin.y})`}
      className={`project-cell ${compact ? "compact-cell" : ""}`}
      style={{ "--project": color } as React.CSSProperties}
    >
      <rect width={CELL_W} height={CELL_H} rx="16" className="cell-body" />
      <path
        d={`M16 0H155M0 16V70M${CELL_W - 155} ${CELL_H}H${CELL_W - 16}M${CELL_W} ${CELL_H - 16}v-54`}
        className="cell-edge"
      />
      <text x="24" y="29" className="cell-index">
        DISTRICT {String(index + 1).padStart(2, "0")}
      </text>
      <g
        role="button"
        tabIndex={0}
        aria-label={`Focus ${project.name}`}
        className="cell-heading"
        onClick={onFocus}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onFocus();
          }
        }}
      >
        <rect x="16" y="10" width="558" height="76" fill="transparent" />
        <text x="24" y="58" className="cell-title">
          {project.name}
        </text>
        <text x="565" y="34" textAnchor="end" className="cell-focus">
          ↗
        </text>
      </g>
      <text x="24" y="80" className="cell-repo">
        {project.repo ?? "Local project"}
      </text>
      <g className="circuit-traces">
        {[0, 6, -6].map((offset) => (
          <path
            key={offset}
            d={`M32 ${174 + offset}H65L84 ${155 + offset}H132L153 ${174 + offset}H209L230 ${155 + offset}H277L299 ${174 + offset}H354L376 ${155 + offset}H420L442 ${174 + offset}H496L512 ${155 + offset}H556`}
          />
        ))}
        {stages.map((stage) => (
          <path key={stage} d={`M${stationX[stage]} 185v126`} />
        ))}
        <circle cx="32" cy="174" r="4" />
        <circle cx="556" cy="155" r="4" />
      </g>
      <path
        d="M255 309v17H110v-17"
        className={`repair-route ${project.tasks.some((t) => t.repairing) ? "repair-on" : ""}`}
      />
      <text x="183" y="341" textAnchor="middle" className="repair-label">
        ↶ REPAIR LOOP
      </text>
      {stages.map((stage, stageIndex) => {
        const tasks = project.tasks.filter((t) => t.station === stage);
        const active = tasks.some((t) => t.signal === "active");
        return (
          <g
            key={stage}
            transform={`translate(${stationX[stage]} 159)`}
            className={`station ${active ? "station-active" : ""}`}
          >
            <text y="-46" textAnchor="middle" className="station-label">
              {stationLabels[stage]}
            </text>
            <rect
              x="-46"
              y="-34"
              width="92"
              height="70"
              rx="10"
              className="chip-shell"
            />
            {[-25, -10, 5, 20].map((x) => (
              <path key={x} className="chip-pin" d={`M${x} -40v6M${x} 36v6`} />
            ))}
            <g className="chip-icon">
              <ChipIcon stage={stage} />
            </g>
            <circle cx="34" cy="-23" r="3" className="station-led" />
            <text y="57" textAnchor="middle" className="station-count">
              {String(tasks.length).padStart(2, "0")}{" "}
              {compact ? "" : stage === "main"
                ? "MERGED"
                : stage === "queue"
                  ? "WAITING / ACTIVE"
                  : "TASKS"}
            </text>
            {!compact && tasks.length > 3 && (
              <g
                role="button"
                tabIndex={0}
                aria-label={`Show ${project.name} ${stationLabels[stage]} tasks`}
                className="overflow-link"
                onClick={() => onSelect(tasks[3]!)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(tasks[3]!);
                }}
              >
                <text x="43" y="151" textAnchor="end">
                  +{tasks.length - 3} more
                </text>
              </g>
            )}
            <text x="-39" y="-23" className="chip-number">
              0{stageIndex + 1}
            </text>
          </g>
        );
      })}
      {visibleTasks.map((task) => {
        const position = positions.get(task.id)!;
        return (
          <g
            key={task.id}
            role="button"
            tabIndex={0}
            aria-label={`${task.key}: ${task.title}, ${stationLabels[task.station]}`}
            aria-pressed={selectedId === task.id}
            className={`task-token signal-${task.signal} ${selectedId === task.id ? "task-selected" : ""} ${matches(task) ? "" : "task-dim"}`}
            style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
            onClick={() => onSelect(task)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(task);
              }
            }}
          >
            <title>
              {task.title}
              {task.queue?.position !== undefined ? ` · Queue position ${task.queue.position}` : ""}
            </title>
            <rect width="87" height="24" rx="5" />
            <text x="9" y="16" className="task-glyph">
              {glyphs[task.signal]}
            </text>
            <text x="26" y="16" className="task-key">
              {task.key.length > 10 ? `${task.key.slice(0, 9)}…` : task.key}
            </text>
            {task.queue?.position !== undefined && (
              <text x="93" y="16" className="queue-position">
                {String(task.queue.position).padStart(2, "0")}
              </text>
            )}
          </g>
        );
      })}
      {project.tasks.some((t) => t.station === "intake") && (
        <text x="28" y="288" className="cell-index">
          INTAKE {compact ? project.tasks.filter((t) => t.station === "intake").length : ""}
        </text>
      )}
    </g>
  );
}

export function World({
  projects,
  selectedId,
  onSelect,
  focused,
  setFocused,
  attention,
  query,
  paused,
}: {
  projects: FactoryProject[];
  selectedId: string | null;
  onSelect: (task: FactoryTask) => void;
  focused: string | null;
  setFocused: (id: string | null) => void;
  attention: boolean;
  query: string;
  paused: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{
    x: number;
    y: number;
    cameraX: number;
    cameraY: number;
  } | null>(null);
  const focusIndex = projects.findIndex((p) => p.id === focused);
  const origin = focusIndex >= 0 ? projectOrigin(focusIndex) : { x: 0, y: 0 };
  const width = focusIndex >= 0 ? 660 : 1280;
  const height =
    focusIndex >= 0
      ? 470
      : Math.max(800, Math.ceil(projects.length / 2) * STEP_Y + 35);
  const base =
    focusIndex >= 0 ? { x: origin.x - 35, y: origin.y - 58 } : origin;
  const view = `${base.x + camera.x} ${base.y + camera.y} ${width / camera.scale} ${height / camera.scale}`;
  const focus = (id: string | null) => {
    setCamera({ x: 0, y: 0, scale: 1 });
    setFocused(id);
  };
  const zoom = (factor: number) =>
    setCamera((c) => {
      const next = Math.max(0.5, Math.min(3.5, c.scale * factor));
      return {
        scale: next,
        x: c.x + width / c.scale / 2 - width / next / 2,
        y: c.y + height / c.scale / 2 - height / next / 2,
      };
    });
  if (focusIndex >= 0) return <ProjectFlow project={projects[focusIndex]!} selectedId={selectedId} onSelect={onSelect} attention={attention} query={query} onBack={() => focus(null)} />;
  return (
    <div className={`world ${paused ? "motion-paused" : ""}`}>
      <div className="world-caption">
        <span className="crosshair">⌖</span>
        <span>
          {focused ? projects[focusIndex]?.name : "All districts"}
          <small> {focused ? " / PROJECT VIEW" : " / WORLD VIEW"}</small>
        </span>
      </div>
      <div className="world-coordinate">
        CIRCUIT CITY <span>v.01</span>
      </div>
      <svg
        ref={ref}
        className="world-svg"
        viewBox={view}
        aria-label="Software factory world"
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) zoom(e.deltaY < 0 ? 1.1 : 0.9);
        }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[role="button"]')) return;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            cameraX: camera.x,
            cameraY: camera.y,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (!start || !ref.current) return;
          const scale = Math.max(
            width / camera.scale / ref.current.clientWidth,
            height / camera.scale / ref.current.clientHeight,
          );
          const x = start.cameraX - (e.clientX - start.x) * scale;
          const y = start.cameraY - (e.clientY - start.y) * scale;
          setCamera((c) => ({ ...c, x, y }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <defs>
          <pattern
            id="grid"
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r="0.8" fill="#263444" />
          </pattern>
        </defs>
        <rect
          x="-10000"
          y="-10000"
          width="20000"
          height="20000"
          fill="url(#grid)"
        />
        {focusIndex < 0 && (
          <g className="backbone">
            {projects.map((_, i) => {
              const o = projectOrigin(i);
              return (
                <path
                  key={i}
                  d={`M${o.x + CELL_W / 2} ${o.y - 20}v-12H650V${o.y + CELL_H + 24}H${o.x + CELL_W / 2}v-24`}
                />
              );
            })}
          </g>
        )}
        {projects.map((project, i) =>
          focusIndex < 0 || i === focusIndex ? (
            <ProjectCell
              key={project.id}
              project={project}
              index={i}
              selectedId={selectedId}
              onSelect={onSelect}
              onFocus={() => focus(project.id)}
              attention={attention}
              query={query}
              compact={camera.scale < 0.85 || (focusIndex < 0 && projects.length > 8)}
            />
          ) : null,
        )}
      </svg>
      <div className="map-tools">
        <button aria-label="Zoom out" onClick={() => zoom(0.8)}>
          −
        </button>
        <span>{Math.round(camera.scale * 100)}%</span>
        <button aria-label="Zoom in" onClick={() => zoom(1.25)}>
          +
        </button>
        <i />
        <button aria-label="Fit all projects" onClick={() => focus(null)}>
          ⛶
        </button>
      </div>
      <div className="map-hint">
        Drag to explore <span>·</span> Select a task to inspect
      </div>
      <div className="mini-map" aria-label="Project minimap">
        {projects.map((p, i) => (
          <button
            key={p.id}
            title={p.name}
            aria-label={`Map: ${p.name}`}
            className={focused === p.id ? "mini-selected" : ""}
            style={{ borderColor: palette[i % 4] }}
            onClick={() => focus(p.id)}
          >
            <span style={{ background: palette[i % 4] }} />
          </button>
        ))}
      </div>
    </div>
  );
}
