import { useEffect, useRef, useState } from "react";
import type { FactoryTask } from "../../src/factory/types.ts";
import { advanceDemo } from "./demo.ts";
import { Inspector } from "./Inspector.tsx";
import { palette, World } from "./World.tsx";
import { useFactory } from "./use-factory.ts";

export function App() {
  const [demo, setDemo] = useState(
    new URLSearchParams(location.search).get("demo") === "1",
  );
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const { snapshot, setSnapshot, connection } = useFactory(demo, token);
  const [selectedId, setSelectedId] = useState<string | null>(
    demo ? "0-0" : null,
  );
  const [focused, setFocused] = useState<string | null>(null);
  const [attention, setAttention] = useState(false);
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const projects = snapshot?.projects ?? [];
  const tasks = projects.flatMap((p) => p.tasks);
  const selected = tasks.find((t) => t.id === selectedId);
  const needsMe = tasks.filter((t) => t.signal === "attention").length;
  const directoryProject =
    attention || query ? focused : (selected?.projectId ?? focused);
  const filtered = tasks.filter(
    (t) =>
      (!directoryProject || t.projectId === directoryProject) &&
      (!attention || t.signal === "attention") &&
      `${t.key} ${t.title}`.toLowerCase().includes(query.toLowerCase()),
  );
  const selectTask = (task: FactoryTask) => {
    setSelectedId(task.id);
  };
  const switchMode = () => {
    const next = !demo;
    setDemo(next);
    setSelectedId(null);
    setFocused(null);
    history.replaceState(null, "", next ? "/factory?demo=1" : "/factory");
  };
  const status = demo
    ? "DEMO WORLD"
    : connection === "live"
      ? "LIVE FEED"
      : connection === "stale"
        ? "FEED INTERRUPTED"
        : connection === "auth"
          ? "AUTH REQUIRED"
          : connection === "disabled"
            ? "API DISABLED"
            : "CONNECTING";
  return (
    <div className="factory-app">
      <header className="app-header">
        <a className="brand" href="/factory">
          <span className="brand-mark">⌘</span>
          <b>PATCHRELAY</b>
        </a>
        <span className="header-divider" />
        <span className="product-name">
          Factory <span>/ Circuit City</span>
        </span>
        <div
          className={`feed-status ${demo ? "feed-demo" : connection !== "live" ? "feed-stale" : ""}`}
          role="status"
        >
          <i />
          {status}
        </div>
        <button className="mode-button" onClick={switchMode}>
          {demo ? "Connect live ↗" : "Explore demo ↗"}
        </button>
      </header>
      <nav className="project-sidebar" aria-label="Projects">
        <div className="workspace-label">
          <span className="workspace-avatar">P</span>
          <div>
            Software factory<small>YOUR WORKSPACE</small>
          </div>
        </div>
        <button
          className={`world-nav ${!focused ? "nav-selected" : ""}`}
          onClick={() => setFocused(null)}
        >
          <span>⌘</span> Factory world <small>{projects.length}</small>
        </button>
        <div className="sidebar-heading">PROJECT DISTRICTS</div>
        <div className="project-list">
          {projects.map((project, index) => (
            <button
              key={project.id}
              className={`project-nav ${focused === project.id ? "nav-selected" : ""}`}
              onClick={() => setFocused(project.id)}
            >
              <i style={{ background: palette[index % 4] }} />
              <span>{project.name}</span>
              <small>
                {project.tasks.filter((t) => t.station !== "main").length}
              </small>
            </button>
          ))}
        </div>
        <div className="sidebar-heading">SIGNAL LEGEND</div>
        <div className="legend">
          <span>
            <i className="signal-active">●</i> Working
          </span>
          <span>
            <i className="signal-waiting">○</i> Waiting
          </span>
          <span>
            <i className="signal-complete">✓</i> Complete
          </span>
          <span>
            <i className="signal-attention">⚠</i> Needs attention
          </span>
        </div>
        <div className="sidebar-bottom">
          <div className="tiny-circuit">
            ┌──◇──┐
            <br />
            ◇&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;◇
            <br />
            └──◇──┘
          </div>
          <p>
            Every task.
            <br />
            One connected world.
          </p>
          <span>OBSERVE · BUILD · MERGE</span>
        </div>
      </nav>
      <main className="main-panel">
        <div className="page-heading">
          <div>
            <p className="eyebrow">THE SOFTWARE FACTORY</p>
            <h1>
              Work, in motion<span>.</span>
            </h1>
            <p className="page-subtitle">
              From first commit to main. Follow the circuit.
            </p>
          </div>
          <div className="heading-actions">
            <button
              aria-pressed={paused}
              className="subtle-button"
              onClick={() => setPaused(!paused)}
            >
              {paused ? "▶ Motion off" : "Ⅱ Pause motion"}
            </button>
          </div>
        </div>
        <div className="toolbar">
          <div className="view-tabs">
            <button className="tab-active" onClick={() => setFocused(null)}>
              ⌖ <span>World</span>
            </button>
            <span className="project-total">{projects.length} districts</span>
          </div>
          <div className="filter-controls">
            <button
              className={`attention-button ${attention ? "filter-active" : ""}`}
              aria-pressed={attention}
              onClick={() => setAttention(!attention)}
            >
              ⚠ Needs me <b>{needsMe}</b>
            </button>
            <label className="search">
              <span>⌕</span>
              <input
                ref={searchRef}
                aria-label="Search tasks"
                placeholder="Find a task…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>/</kbd>
            </label>
          </div>
        </div>
        {demo && (
          <div className="demo-strip">
            <span>
              <b>DEMO</b> Illustrative tasks · no services connected
            </span>
            <button
              onClick={() =>
                setSnapshot((value) => (value ? advanceDemo(value) : value))
              }
            >
              Advance PR-142 →
            </button>
          </div>
        )}
        {!demo && connection === "stale" && (
          <div className="connection-banner" role="alert">
            Connection interrupted. Showing the last observation; reconnecting
            automatically.
          </div>
        )}
        {!demo && connection === "auth" ? (
          <div className="empty-state">
            <span>⌘</span>
            <h2>Connect to your factory</h2>
            <p>
              This server requires its existing operator token. It stays in
              memory for this tab.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setToken(tokenInput);
                setTokenInput("");
              }}
            >
              <input
                type="password"
                aria-label="Operator token"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Operator token"
                required
                autoComplete="off"
              />
              <button className="primary-button">Connect</button>
            </form>
          </div>
        ) : !demo && connection === "disabled" ? (
          <div className="empty-state">
            <h2>Operator API is disabled</h2>
            <p>
              Open the factory on the local service, or enable the existing
              operator API to access live data.
            </p>
            <button className="primary-button" onClick={switchMode}>
              Explore demo
            </button>
          </div>
        ) : projects.length > 0 ? (
          <World
            key={focused ?? "all"}
            projects={projects}
            selectedId={selectedId}
            onSelect={selectTask}
            focused={focused}
            setFocused={setFocused}
            attention={attention}
            query={query}
            paused={paused || (!demo && connection !== "live")}
          />
        ) : (
          <div className="empty-state">
            <span>⌖</span>
            <h2>
              {snapshot
                ? "Your circuit starts here."
                : "Connecting the circuit…"}
            </h2>
            <p>
              {snapshot
                ? "Configured projects and tracked work will appear here as districts."
                : "Waiting for the first factory snapshot."}
            </p>
            <button className="primary-button" onClick={switchMode}>
              Explore a demo world
            </button>
          </div>
        )}
        <div className="world-footer">
          <span>
            <i className="signal-complete">◇</i>{" "}
            {demo ? "SAMPLE DATA" : "OBSERVED WORKFLOW"}
          </span>
          <span>
            {attention
              ? `${needsMe} tasks need attention`
              : "Implementation → Review → Merge queue → Main"}
          </span>
          <span>SVG WORLD ENGINE</span>
        </div>
      </main>
      <Inspector
        task={selected}
        tasks={filtered}
        onSelect={selectTask}
        token={token}
        demo={demo}
        onClose={() => setSelectedId(null)}
      />
      <footer className="service-bar">
        <span className="service-label">
          {demo ? "DEMO SOURCES" : "DATA SOURCES"}
        </span>
        {snapshot?.sources.map((source) => (
          <span
            className={`source source-${source.state}`}
            key={source.id}
            title={source.detail}
          >
            <i />
            {source.name}
            <small>{demo ? "sample" : source.state}</small>
          </span>
        ))}
        <span className="service-tail">
          {demo
            ? "SIMULATION"
            : connection === "live"
              ? "STREAMING · 5s"
              : "OFFLINE"}
        </span>
      </footer>
    </div>
  );
}
