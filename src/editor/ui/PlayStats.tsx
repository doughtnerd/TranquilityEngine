// The play bar's own tools (Gizmos toggle with its kinds menu, Stats toggle) and the Stats overlay
// in the game view's corner. Mounted into the game view's play bar and overlay layer for each play
// session (`mountPlayTools`, from session.ts), with the Input debugger's input overlay (`InputOverlay.tsx`) beside Stats.
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { setEngineTiming } from "../../engine/editor";
import { PLAY_GIZMO_KINDS, cleanPlayGizmos, playGizmos, updatePlayGizmos } from "../playGizmos";
import type { PlaySession } from "../playMode";
import { StatsCollector, megabytes, takeSnapshot, type StatsSnapshot, type WorldStats } from "../playStats";
import { persisted } from "../preferences";
import { InputOverlay } from "./InputOverlay";
import { usePopover } from "./popover";
import "./playstats.css";

/** Whether the Stats overlay shows while playing, remembered per user. */
const playStatsShown = persisted("myco.editor.playStats", false);

/** How often the Stats overlay refreshes (about 4 Hz). */
const REFRESH_MS = 250;

/** Render the play bar's tools and the Stats overlay into `session`'s game view. Returns a function that removes them. */
export function mountPlayTools(session: PlaySession): () => void {
  const view = session.view;
  if (!view) return () => {};
  render(<PlayBarTools />, view.tools);
  render(
    <>
      <PlayStatsOverlay session={session} />
      <InputOverlay />
    </>,
    view.hud,
  );
  return () => {
    render(null, view.tools);
    render(null, view.hud);
  };
}

function PlayBarTools() {
  const s = cleanPlayGizmos(playGizmos.value);
  const stats = playStatsShown.value;
  return (
    <div class="play-tools-group" role="group" aria-label="Play view">
      <span class="gizmos-split">
        <button
          class="gizmos-toggle"
          aria-pressed={s.enabled}
          title={s.enabled ? "Hide every gizmo and debug drawing in the play view" : "Show gizmos and debug drawing in the play view"}
          onClick={() => updatePlayGizmos({ enabled: !s.enabled })}
        >
          Gizmos
        </button>
        <GizmoMenu />
      </span>
      <button class="stats-toggle" aria-pressed={stats} title="Show frame rate, timings and render counters over the play view" onClick={() => (playStatsShown.value = !stats)}>
        Stats
      </button>
    </div>
  );
}

/** The ▾ beside Gizmos: a checkbox per kind, applying while Gizmos is on. Opens above the bar. */
function GizmoMenu() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Above the bar, right-aligned with its button, in the window the game view is in (ADR 0174).
  usePopover(panel, open, { anchor: button.current, side: "above", align: "end", margin: 8, inside: [button], onDismiss: () => setOpen(false) });
  const s = cleanPlayGizmos(playGizmos.value);
  return (
    <>
      <button ref={button} class="gizmos-menu-button" aria-label="Gizmo kinds" aria-expanded={open} aria-haspopup="dialog" title="Choose which gizmos show while Gizmos is on" onClick={() => setOpen(!open)}>
        ▾
      </button>
      {open && (
        <div ref={panel} class="scene-popover gizmos-menu" role="dialog" aria-label="Gizmo kinds">
          {PLAY_GIZMO_KINDS.map((k) => (
            <label key={k.key} class={`gizmos-kind${s.enabled ? "" : " off"}`} title={k.title}>
              <input type="checkbox" checked={s[k.key]} onChange={(e) => updatePlayGizmos({ [k.key]: (e.currentTarget as HTMLInputElement).checked })} />
              {k.label}
            </label>
          ))}
          {!s.enabled && <p class="gizmos-note">Gizmos is off: nothing shows.</p>}
        </div>
      )}
    </>
  );
}

function PlayStatsOverlay(props: { session: PlaySession }) {
  const shown = playStatsShown.value;
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);
  useEffect(() => {
    if (!shown) return;
    const engine = props.session.engine;
    const collector = new StatsCollector();
    setEngineTiming(engine, collector);
    const tick = () => {
      try {
        setSnapshot(takeSnapshot(engine, collector));
      } catch (err) {
        console.warn("[myco] Couldn't read the play stats:", err); // a World torn down meanwhile
      }
    };
    tick();
    const timer = setInterval(tick, REFRESH_MS);
    return () => {
      clearInterval(timer);
      setEngineTiming(engine, null);
      setSnapshot(null);
    };
  }, [shown, props.session]);
  if (!shown) return null;
  const f = snapshot?.frame ?? null;
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toFixed(2));
  return (
    <div class="play-stats" role="region" aria-label="Stats">
      <button class="play-stats-close" aria-label="Close stats" title="Hide Stats" onClick={() => (playStatsShown.value = false)}>
        ×
      </button>
      <table>
        <tbody>
          <tr>
            <th>FPS</th>
            <td data-stat="fps">{f ? f.fps.toFixed(0) : "–"}</td>
            <td class="sub" data-stat="fps-range">{f ? `min ${f.minFps.toFixed(0)} · avg ${f.avgFps.toFixed(0)}` : snapshot ? "paused" : ""}</td>
          </tr>
          <tr>
            <th>Frame</th>
            <td data-stat="frame-ms">{f ? `${f.frameMs.toFixed(1)} ms` : "–"}</td>
            <td class="sub">step {ms(snapshot?.stepMs)} ms</td>
          </tr>
          <tr>
            <th>JS heap</th>
            <td colSpan={2} data-stat="heap">{snapshot?.heap ? `${megabytes(snapshot.heap.used)} / ${megabytes(snapshot.heap.limit)}` : "n/a"}</td>
          </tr>
        </tbody>
        {snapshot?.worlds.map((w) => <WorldRows key={w.name} w={w} ms={ms} />)}
      </table>
    </div>
  );
}

function WorldRows(props: { w: WorldStats; ms: (v: number | null | undefined) => string }) {
  const { w, ms } = props;
  const r = w.render;
  return (
    <tbody class="play-stats-world" data-world={w.name}>
      <tr class="world-head">
        <th colSpan={3}>
          World {w.name}
          {w.paused ? " (paused)" : ""}
        </th>
      </tr>
      <tr>
        <th>Update</th>
        <td data-stat="update-ms">{ms(w.phases?.updateMs)} ms</td>
        <td class="sub">fixed {ms(w.phases?.fixedMs)} · render {ms(w.phases?.renderMs)} ms</td>
      </tr>
      {r ? (
        <>
          <tr>
            <th>Draw calls</th>
            <td data-stat="draw-calls">{r.drawCalls.toLocaleString()}</td>
            <td class="sub">{r.lines ? `lines ${r.lines.toLocaleString()}` : ""}</td>
          </tr>
          <tr>
            <th>Triangles</th>
            <td colSpan={2} data-stat="triangles">{r.triangles.toLocaleString()}</td>
          </tr>
          <tr>
            <th>GPU</th>
            <td colSpan={2} data-stat="gpu">
              geo {r.geometries} · tex {r.textures} · prog {r.programs}
            </td>
          </tr>
        </>
      ) : (
        <tr>
          <th>Render</th>
          <td colSpan={2}>headless</td>
        </tr>
      )}
      <tr>
        <th>Nodes</th>
        <td data-stat="nodes">{w.nodes.toLocaleString()}</td>
        <td class="sub">{w.counters.map((c) => `${c.label} ${c.value}`).join(" · ")}</td>
      </tr>
      <PlayStatsTables tables={w.tables} />
    </tbody>
  );
}

/** A World's plugin tables (T34): a heading row, then a label, value and muted detail per row. */
export function PlayStatsTables(props: { tables: WorldStats["tables"] }) {
  return (
    <>
      {props.tables.map((t) => (
        <>
          <tr class="plugin-table-head" data-table={t.title}>
            <th colSpan={3}>{t.title}</th>
          </tr>
          {t.rows.map((r) => (
            <tr key={r.label}>
              <th>{r.label}</th>
              <td data-stat={`${t.title}:${r.label}`}>{r.value}</td>
              <td class="sub">{r.detail ?? ""}</td>
            </tr>
          ))}
        </>
      ))}
    </>
  );
}
