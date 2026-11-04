import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { actionLabel, alignTargets, minNodes, runAlign, type AlignAction, type Axis } from "../align";
import { previewCamera, previewFrame, selectedCamera } from "../cameraPreview";
import { cameraPreviewEnabled, cleanSnap, gizmoPivot, gizmoSpace, snapSettings, toggleGizmoPivot, toggleGizmoSpace, updateSnap, type SnapSettings } from "../sceneTools";
import { docVersion, openScene, sceneCamera, selectedKeys, viewMode } from "../state";
import { previewedQuality, previewQuality, qualityTiers } from "../graphicsPreview";
import { NavOverlayForm } from "./NavDebugPanel";
import "./scene-tools.css";

/**
 * The Scene toolbar's tool settings (ADR 0022): gizmo space (X) and pivot (Z), snapping (an
 * "always snap" toggle and a popover with the steps and grid), Align and distribute, and the camera
 * preview toggle. They go inside the toolbar element, after its tools.
 */
export function SceneToolButtons() {
  const space = gizmoSpace.value, pivot = gizmoPivot.value;
  const snap = cleanSnap(snapSettings.value);
  return (
    <>
      <div class="group" role="group" aria-label="Gizmo placement">
        <button class="gizmo-space" aria-pressed={space === "local"} title={`Gizmo space: ${space === "local" ? "Local (the node's axes)" : "World (the world's axes)"}. X toggles.`} onClick={toggleGizmoSpace}>
          {space === "local" ? "Local" : "World"}
        </button>
        <button class="gizmo-pivot" aria-pressed={pivot === "pivot"} title={`Several nodes: the gizmo sits ${pivot === "pivot" ? "on the active node's origin (Pivot)" : "at the selection's centre (Center)"}. Z toggles.`} onClick={toggleGizmoPivot}>
          {pivot === "pivot" ? "Pivot" : "Center"}
        </button>
      </div>
      <div class="group" role="group" aria-label="Snapping">
        <button class={`snap-toggle${snap.always ? " active" : ""}`} aria-pressed={snap.always} title="Always snap gizmo drags (otherwise hold Ctrl)" onClick={() => updateSnap({ always: !snap.always })}>
          Snap
        </button>
        <Popover label="Snap settings" buttonClass="snap-settings" buttonText="▾" title="Snap steps and grid">
          <SnapSettingsForm settings={snap} />
        </Popover>
      </div>
      <AlignMenu />
      <Popover label="Navigation overlay" buttonClass="nav-overlay" buttonText="Nav" title="Draw the baked navmesh, links and flight volume in the scene view">
        <NavOverlayForm />
      </Popover>
      <button
        class={`camera-preview-toggle${cameraPreviewEnabled.value ? " active" : ""}`}
        aria-pressed={cameraPreviewEnabled.value}
        title={selectedCamera.value ? "Show what the selected camera sees in a corner of the view" : "Show what a selected camera sees in a corner of the view (select a Camera node)"}
        onClick={() => (cameraPreviewEnabled.value = !cameraPreviewEnabled.value)}
      >
        Preview
      </button>
      <select
        class="quality-select"
        aria-label="Quality"
        title="Preview a graphics quality tier in the editor (players choose theirs with Graphics.quality)"
        value={previewedQuality.value}
        onChange={(e) => previewQuality((e.currentTarget as HTMLSelectElement).value)}
      >
        {qualityTiers.value.map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
    </>
  );
}

/** A toolbar button that opens a small panel below it (fixed to the window, so panels don't clip it). */
function Popover(props: { label: string; buttonText: string; buttonClass: string; title: string; disabled?: boolean; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Record<string, string>>({ visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = panel.current?.offsetWidth ?? 220;
    setPlace({ top: `${r.bottom + 4}px`, left: `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px` });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    // Escape closes it wherever focus is (and doesn't reach the editor's own Escape handling).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      if (panel.current?.contains(document.activeElement)) button.current?.focus();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);
  return (
    <>
      <button ref={button} class={props.buttonClass} aria-label={props.label} aria-expanded={open} aria-haspopup="dialog" title={props.title} disabled={props.disabled} onClick={() => setOpen(!open)}>
        {props.buttonText}
      </button>
      {open && (
        <div
          ref={panel}
          class="scene-popover"
          role="dialog"
          aria-label={props.label}
          tabIndex={-1}
          style={place}
        >
          {props.children}
        </div>
      )}
    </>
  );
}

const SNAP_FIELDS: { key: "move" | "rotate" | "scale" | "grid"; label: string; unit: string }[] = [
  { key: "move", label: "Move step", unit: "m" },
  { key: "rotate", label: "Rotate step", unit: "°" },
  { key: "scale", label: "Scale step", unit: "×" },
  { key: "grid", label: "Grid size", unit: "m" },
];

function SnapSettingsForm(props: { settings: SnapSettings }) {
  const s = props.settings;
  return (
    <div class="snap-form">
      {SNAP_FIELDS.map((f) => (
        <label key={f.key} class="snap-row">
          <span>{f.label}</span>
          <StepInput value={s[f.key]} label={f.label} onCommit={(v) => updateSnap({ [f.key]: v })} />
          <span class="unit">{f.unit}</span>
        </label>
      ))}
      <label class="snap-row check">
        <input type="checkbox" checked={s.showGrid} aria-label="Show grid" onChange={(e) => updateSnap({ showGrid: (e.currentTarget as HTMLInputElement).checked })} />
        <span>Show grid</span>
      </label>
      <label class="snap-row check">
        <input type="checkbox" checked={s.always} aria-label="Always snap" onChange={(e) => updateSnap({ always: (e.currentTarget as HTMLInputElement).checked })} />
        <span>Always snap (else hold Ctrl)</span>
      </label>
    </div>
  );
}

/** A positive number field that commits on Enter or blur and reverts on Escape or bad input. */
function StepInput(props: { value: number; label: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) {
      if (n !== props.value) props.onCommit(n);
    } else {
      setDraft(String(props.value));
    }
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={props.label}
      value={draft}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setDraft(String(props.value));
      }}
    />
  );
}

const ALIGN_2D: AlignAction[] = [
  { kind: "align", axis: 0, edge: "min" },
  { kind: "align", axis: 0, edge: "center" },
  { kind: "align", axis: 0, edge: "max" },
  { kind: "align", axis: 1, edge: "max" },
  { kind: "align", axis: 1, edge: "center" },
  { kind: "align", axis: 1, edge: "min" },
];

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Align and distribute the selected nodes: by their bounds, in the 2D view's terms or along X, Y and Z in 3D. */
function AlignMenu() {
  docVersion.value;
  selectedKeys.value;
  const scene = openScene.value;
  const count = scene ? alignTargets(scene.doc).length : 0;
  const planar = viewMode.value === "2d";
  const rows: AlignAction[][] = planar
    ? [ALIGN_2D.slice(0, 3), ALIGN_2D.slice(3), [{ kind: "distribute", axis: 0 }, { kind: "distribute", axis: 1 }]]
    : [
        ...([0, 1, 2] as Axis[]).map((axis) => (["min", "center", "max"] as const).map((edge): AlignAction => ({ kind: "align", axis, edge }))),
        ([0, 1, 2] as Axis[]).map((axis): AlignAction => ({ kind: "distribute", axis })),
      ];
  return (
    <Popover label="Align" buttonClass="align-menu" buttonText="Align ▾" title={count < 2 ? "Align and distribute: select two or more nodes" : `Align and distribute ${count} nodes`} disabled={count < 2}>
      <div class="align-grid">
        {rows.map((row, i) => (
          <div key={i} class="align-row">
            {row.map((a) => {
              const label = actionLabel(a, planar);
              return (
                <button key={label} disabled={count < minNodes(a)} title={count < minNodes(a) ? `${label}: select ${minNodes(a)} or more nodes` : label} onClick={() => runAlign(a, planar)}>
                  {capitalize(label.replace(/^(Align|Distribute) /, ""))}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </Popover>
  );
}

/** The camera preview's frame: the engine draws what the selected camera sees into the canvas under it. */
export function CameraPreviewFrame() {
  const node = previewCamera.value;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    previewFrame.value = ref.current;
    return () => {
      if (previewFrame.peek() === ref.current) previewFrame.value = null;
    };
  }, [node !== null]);
  if (!node) return null;
  const display = sceneCamera.value?.world.settings.display ?? { width: 16, height: 9 };
  return (
    <div ref={ref} class="camera-preview" style={{ aspectRatio: `${display.width} / ${display.height}` }} aria-label={`Camera preview: ${node.name}`} role="img">
      <span class="camera-preview-label">{node.name}</span>
    </div>
  );
}
