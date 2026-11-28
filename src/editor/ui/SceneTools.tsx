import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { actionLabel, alignTargets, minNodes, runAlign, whyNotAlign, type AlignAction, type Axis } from "../align";
import { statusSentence } from "../editGate";
import { previewCamera, previewFrame, selectedCamera } from "../cameraPreview";
import { cameraPreviewEnabled, cleanDebugMode, cleanSnap, freezeCulling, gizmoPivot, gizmoSpace, lighting2DShown, occlusionValidator, sceneOcclusion, snapSettings, toggleGizmoPivot, toggleGizmoSpace, updateSnap, visibilityDebug, type SnapSettings, type VisibilityDebugMode } from "../sceneTools";
import { docVersion, openScene, sceneCamera, selectedKeys, viewMode } from "../state";
import { rotationAngles } from "../preferences";
import { previewedQuality, previewQuality, qualityTiers } from "../graphicsPreview";
import { sceneToolbarItems, type SceneToolbarItemContribution } from "../sdk/contributions";
import { lazyComponent, type LazyComponent } from "./lazy";
import { usePopover } from "./popover";
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
        <button class={`snap-toggle toggle${snap.always ? " active" : ""}`} aria-pressed={snap.always} title="Always snap gizmo drags (otherwise hold Ctrl)" onClick={() => updateSnap({ always: !snap.always })}>
          Snap
        </button>
        <Popover label="Snap settings" buttonClass="snap-settings" buttonText="▾" title="Snap steps and grid">
          <SnapSettingsForm settings={snap} />
        </Popover>
      </div>
      <AlignMenu />
      <Popover label="View" buttonClass="view-menu" buttonText="View ▾" title="Visibility tools: occlusion culling, freeze culling, the validator and debug views">
        <ViewMenu />
      </Popover>
      <SceneToolbarItems />
      <button
        class={`camera-preview-toggle toggle${cameraPreviewEnabled.value ? " active" : ""}`}
        aria-pressed={cameraPreviewEnabled.value}
        title={selectedCamera.value ? "Show what the selected camera sees in a corner of the view" : "Show what a selected camera sees in a corner of the view (select a Camera node)"}
        onClick={() => (cameraPreviewEnabled.value = !cameraPreviewEnabled.value)}
      >
        Preview
      </button>
      <button
        class={`lighting2d-toggle toggle${lighting2DShown.value ? " active" : ""}`}
        aria-pressed={lighting2DShown.value}
        title={lighting2DShown.value ? "2D lighting is on: sprites, tiles and 2D lines are lit by 2D lights. Click to draw them unlit." : "2D lighting is off: 2D draws are unlit. Click to light them by 2D lights."}
        onClick={() => (lighting2DShown.value = !lighting2DShown.value)}
      >
        2D Lights
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

// One lazy wrapper per contribution object: a popover's content loads when it first opens.
const itemViews = new WeakMap<SceneToolbarItemContribution, LazyComponent>();
const lazyItem = (item: SceneToolbarItemContribution): LazyComponent => {
  let lazy = itemViews.get(item);
  if (!lazy) itemViews.set(item, (lazy = lazyComponent(item.view, null)));
  return lazy;
};

/** The plugins' toolbar popovers (ADR 0142), in registration order: the Navigation plugin's Nav overlay. */
function SceneToolbarItems() {
  sceneToolbarItems.version.value;
  return (
    <>
      {sceneToolbarItems.list().map((item: SceneToolbarItemContribution) => (
        <Popover key={item.id} label={item.label} buttonClass={item.buttonClass} buttonText={item.buttonText} title={item.title}>
          {lazyItem(item)()}
        </Popover>
      ))}
    </>
  );
}

/** A toolbar button that opens a small panel below it (fixed to the window, so panels don't clip it). */
function Popover(props: { label: string; buttonText: string; buttonClass: string; title: string; disabled?: boolean; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Below its button, kept in the window it's in (a detached panel window, ADR 0174). Escape closes it
  // wherever focus is (and doesn't reach the editor's own Escape handling).
  usePopover(panel, open, { anchor: button.current, margin: 8, inside: [button], onDismiss: () => setOpen(false) });
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
        >
          {props.children}
        </div>
      )}
    </>
  );
}

const SNAP_FIELDS: { key: "move" | "rotate" | "scale" | "grid"; label: string; unit: string }[] = [
  { key: "move", label: "Move step", unit: "m" },
  { key: "rotate", label: "Rotate step", unit: "rad" },
  { key: "scale", label: "Scale step", unit: "×" },
  { key: "grid", label: "Grid size", unit: "m" },
];

/** Rounds a shown step so float noise (π/12 as 0.2617993877991494) doesn't show. */
const shownStep = (n: number): number => Math.round(n * 1e4) / 1e4;

function SnapSettingsForm(props: { settings: SnapSettings }) {
  const s = props.settings;
  // The rotate step is stored in radians (ADR 0164) and shown in the Inspector's Rotation angles unit (ADR 0165).
  const degrees = rotationAngles.value === "degrees";
  const shown = (key: (typeof SNAP_FIELDS)[number]["key"]) => (key === "rotate" ? shownStep(degrees ? (s.rotate * 180) / Math.PI : s.rotate) : s[key]);
  const commit = (key: (typeof SNAP_FIELDS)[number]["key"], v: number) => updateSnap({ [key]: key === "rotate" && degrees ? (v * Math.PI) / 180 : v });
  return (
    <div class="snap-form">
      {SNAP_FIELDS.map((f) => (
        <label key={f.key} class="snap-row">
          <span>{f.label}</span>
          <StepInput value={shown(f.key)} label={f.label} onCommit={(v) => commit(f.key, v)} />
          <span class="unit">{f.key === "rotate" && degrees ? "°" : f.unit}</span>
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
  useLayoutEffect(() => setDraft(String(props.value)), [props.value]);
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
  // During play the scene is read-only (ADR 0247): the menu says so instead of moving nodes.
  const blocked = scene ? whyNotAlign() : null;
  return (
    <Popover
      label="Align"
      buttonClass="align-menu"
      buttonText="Align ▾"
      title={blocked ? `Align and distribute: ${statusSentence(blocked)}` : count < 2 ? "Align and distribute: select two or more nodes" : `Align and distribute ${count} nodes`}
      disabled={count < 2 || blocked !== null}
    >
      <div class="align-grid">
        {rows.map((row, i) => (
          <div key={i} class="align-row">
            {row.map((a) => {
              const label = actionLabel(a, planar);
              const why = whyNotAlign(a, planar) ?? (count < minNodes(a) ? `select ${minNodes(a)} or more nodes` : null);
              return (
                <button key={label} disabled={why !== null} title={why ? `${label}: ${why}` : label} onClick={() => runAlign(a, planar)}>
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

const DEBUG_MODES: { mode: VisibilityDebugMode; label: string; title: string }[] = [
  { mode: "none", label: "None", title: "Draw the scene as it is" },
  { mode: "lodLevels", label: "LOD levels", title: "Tint each renderer by the LOD level it draws (the LOD bar's colours)" },
  { mode: "occlusion", label: "Occlusion", title: "Show the occlusion buffer, what it culled (red boxes) and its numbers" },
];

/**
 * The View popover (ADR 0460 §4, §6, 0459 §7): occlusion culling for the scene view (off by default, so editing shows
 * everything), freeze culling, the validator, and the visibility debug view.
 */
function ViewMenu() {
  const debug = cleanDebugMode(visibilityDebug.value);
  const check = (label: string, title: string, value: boolean, set: (on: boolean) => void) => (
    <label class="snap-row check" title={title}>
      <input type="checkbox" checked={value} aria-label={label} onChange={(e) => set((e.currentTarget as HTMLInputElement).checked)} />
      <span>{label}</span>
    </label>
  );
  return (
    <div class="snap-form view-menu-form">
      {check("Occlusion culling", "Hide what the scene view can't see behind occluders, as game cameras do", sceneOcclusion.value === true, (on) => (sceneOcclusion.value = on))}
      {check("Freeze culling", "Keep the scene view's current LOD levels and hidden objects while the camera moves", freezeCulling.value === true, (on) => (freezeCulling.value = on))}
      {check("Validator", "Draw what occlusion hid anyway, in red: red you can see is a false occlusion", occlusionValidator.value === true, (on) => (occlusionValidator.value = on))}
      <fieldset class="view-menu-debug">
        <legend>Visibility debug</legend>
        {DEBUG_MODES.map((m) => (
          <label key={m.mode} class="snap-row check" title={m.title}>
            <input type="radio" name="visibility-debug" checked={debug === m.mode} aria-label={m.label} onChange={() => (visibilityDebug.value = m.mode)} />
            <span>{m.label}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

/** The occlusion debug view's inset (ADR 0460 §6): the buffer as a grey depth image and the readout, in a corner of the scene view. */
const LazyDebugInset = lazyComponent(() => import("./VisibilityDebugInset").then((m) => m.VisibilityDebugInset), null);

/** The occlusion debug inset while the View menu's debug view is "Occlusion" (its code loads the first time). */
export function OcclusionDebugInset() {
  return cleanDebugMode(visibilityDebug.value) === "occlusion" ? <LazyDebugInset /> : null;
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
  const display = sceneCamera.value?._world.settings.display ?? { width: 16, height: 9 };
  return (
    <div ref={ref} class="camera-preview" style={{ aspectRatio: `${display.width} / ${display.height}` }} aria-label={`Camera preview: ${node.name}`} role="img">
      <span class="camera-preview-label">{node.name}</span>
    </div>
  );
}
