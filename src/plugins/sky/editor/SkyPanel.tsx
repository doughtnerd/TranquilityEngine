// The Sky panel (ADR 0112, 0134): edits a `*.sky.json` asset layer by layer with a live preview.
// Part of the Sky plugin; loaded lazily the first time it shows; its form is driven by the
// `SECTIONS` table below. Editing goes through the sky's asset document, which keeps undo and redo,
// writes the file (sliders after a short pause) and follows changes made elsewhere; the preview,
// the thumbnails and any scene using the sky then pick the file up.
import { SKY_PRESETS, skyPreset, type SkyPresetId } from "../../../engine/sky/presets";
import { cloneSky, defaultCloudLayer, MAX_CLOUD_LAYERS, type SkySettings } from "../../../engine/sky/skyFormat";
import { skyLight, sunAngles } from "../../../engine/sky/skyMath";
import { AssetDocumentFrame, AssetPicker, ColorField, openAssetDocument, editor, LargePreview, Panel, SliderField, EmptyState } from "../../../editor/sdk";
import "./skyPanel.css";

type Path = readonly (string | number)[];

type Field =
  | { kind: "number"; label: string; path: Path; min: number; max: number; step: number; hint?: string }
  | { kind: "bool"; label: string; path: Path; hint?: string }
  | { kind: "color"; label: string; path: Path }
  | { kind: "choice"; label: string; path: Path; options: readonly [string, string][] }
  | { kind: "image"; label: string; path: Path; hint?: string };

interface Section {
  title: string;
  fields: Field[];
  /** Shown only when this holds. */
  when?: (s: SkySettings) => boolean;
}

const num = (label: string, path: Path, min: number, max: number, step: number, hint?: string): Field => ({ kind: "number", label, path, min, max, step, hint });

const SECTIONS: Section[] = [
  { title: "Sky", fields: [{ kind: "choice", label: "Mode", path: ["mode"], options: [["atmosphere", "Atmosphere (physically based)"], ["gradient", "Gradient"]] }, num("Exposure", ["exposure"], -6, 6, 0.1, "Stops: +1 is twice as bright")] },
  {
    title: "Atmosphere",
    when: (s) => s.mode === "atmosphere",
    fields: [
      num("Rayleigh", ["atmosphere", "rayleigh"], 0, 5, 0.05, "Air scattering: bluer days, redder sunsets"),
      num("Mie (haze)", ["atmosphere", "mie"], 0, 20, 0.1, "Haze: whiter sky, brighter glow round the sun"),
      num("Haze direction", ["atmosphere", "mieAnisotropy"], 0, 0.99, 0.01),
      { kind: "color", label: "Ground", path: ["atmosphere", "groundColor"] },
    ],
  },
  {
    title: "Gradient",
    when: (s) => s.mode === "gradient",
    fields: [
      { kind: "color", label: "Zenith", path: ["gradient", "zenith"] },
      { kind: "color", label: "Horizon", path: ["gradient", "horizon"] },
      { kind: "color", label: "Ground", path: ["gradient", "ground"] },
      num("Sharpness", ["gradient", "sharpness"], 0.1, 16, 0.1),
    ],
  },
  {
    title: "Sun position",
    fields: [
      { kind: "choice", label: "Placement", path: ["sun", "placement"], options: [["timeOfDay", "Time of day"], ["manual", "Elevation and azimuth"]] },
      num("Time of day", ["sun", "timeOfDay"], 0, 24, 0.05, "Hours, local solar time"),
      num("Latitude", ["sun", "latitude"], -90, 90, 1),
      num("Day of year", ["sun", "dayOfYear"], 1, 365, 1),
      num("Elevation", ["sun", "elevation"], -90, 90, 0.5),
      num("Azimuth", ["sun", "azimuth"], 0, 360, 1, "Degrees clockwise from north"),
      num("North offset", ["sun", "northOffset"], -180, 180, 1, "Degrees from the World's -Z axis to north"),
    ],
  },
  {
    title: "Sun disc",
    fields: [{ kind: "bool", label: "Show", path: ["sunDisc", "enabled"] }, num("Size", ["sunDisc", "size"], 0, 10, 0.05, "Angular diameter in degrees"), num("Glow", ["sunDisc", "glow"], 0, 1, 0.01), { kind: "color", label: "Colour", path: ["sunDisc", "color"] }, num("Brightness", ["sunDisc", "intensity"], 0, 10, 0.1)],
  },
  {
    title: "Moon",
    fields: [
      { kind: "bool", label: "Show", path: ["moon", "enabled"] },
      num("Size", ["moon", "size"], 0, 10, 0.05),
      num("Glow", ["moon", "glow"], 0, 1, 0.01),
      { kind: "color", label: "Colour", path: ["moon", "color"] },
      num("Brightness", ["moon", "intensity"], 0, 10, 0.1),
      { kind: "bool", label: "Phase from date", path: ["moon", "autoPhase"] },
      num("Phase", ["moon", "phase"], 0, 1, 0.01, "0 new, 0.5 full"),
      { kind: "image", label: "Texture", path: ["moon", "texture"], hint: "An image wrapped on the disc" },
    ],
  },
  {
    title: "Stars",
    fields: [
      { kind: "bool", label: "Show", path: ["stars", "enabled"] },
      num("Density", ["stars", "density"], 0, 1, 0.01),
      num("Brightness", ["stars", "brightness"], 0, 10, 0.1),
      num("Twinkle", ["stars", "twinkle"], 0, 1, 0.01),
      { kind: "image", label: "Milky Way", path: ["stars", "milkyWay"], hint: "An equirectangular image" },
      num("Milky Way brightness", ["stars", "milkyWayIntensity"], 0, 5, 0.05),
    ],
  },
  { title: "Horizon", fields: [num("Fog blend", ["horizon", "fogBlend"], 0, 1, 0.01, "Fades the horizon to the World's Fog colour"), num("Height", ["horizon", "height"], 0, 90, 0.5, "Degrees above the horizon"), { kind: "color", label: "Colour without Fog", path: ["horizon", "color"] }] },
  {
    title: "Lighting",
    fields: [
      { kind: "bool", label: "Drive sun light", path: ["lighting", "driveSunLight"], hint: "The main directional light follows the sun (the moon at night)" },
      num("Sun intensity", ["lighting", "sunIntensity"], 0, 20, 0.1),
      num("Moon intensity", ["lighting", "moonIntensity"], 0, 2, 0.01),
      { kind: "bool", label: "Bake lighting", path: ["lighting", "bake"], hint: "Reflections and ambient light from the sky" },
      { kind: "choice", label: "Bake size", path: ["lighting", "bakeSize"], options: [["32", "32"], ["64", "64"], ["128", "128"], ["256", "256"], ["512", "512"]] },
      num("Rebake every (hours)", ["lighting", "rebakeHours"], 0, 6, 0.05, "Game hours of sun movement between bakes"),
      num("At most every (s)", ["lighting", "rebakeInterval"], 0, 10, 0.1),
    ],
  },
];

const CLOUD_FIELDS: Field[] = [
  { kind: "bool", label: "Show", path: ["enabled"] },
  num("Coverage", ["coverage"], 0, 1, 0.01),
  num("Density", ["density"], 0, 1, 0.01),
  num("Scale", ["scale"], 0.1, 10, 0.05),
  num("Speed", ["speed"], -20, 20, 0.1),
  num("Direction", ["direction"], 0, 360, 1, "Degrees clockwise from north the wind blows towards"),
  num("Altitude", ["altitude"], 0.1, 20, 0.1, "km: lower layers curve to the horizon sooner"),
  { kind: "color", label: "Colour", path: ["color"] },
];

const get = (o: unknown, path: Path): unknown => path.reduce<unknown>((v, k) => (v as Record<string | number, unknown>)?.[k], o);
function set<T>(o: T, path: Path, value: unknown): T {
  const copy = cloneSky(o as SkySettings) as unknown as Record<string | number, unknown>;
  let at = copy;
  for (const k of path.slice(0, -1)) at = at[k] as Record<string | number, unknown>;
  at[path[path.length - 1]] = value;
  return copy as unknown as T;
}

export function SkyPanel() {
  const path = editor.assets.openIn("sky");
  const project = editor.project.current;
  editor.project.version; // the file list changes with it
  if (!project || !path) return <Panel><EmptyState compact title="Double-click a sky asset (.sky.json) in the Assets panel, or create one with New Sky." /></Panel>;
  if (!project.files.includes(path)) return <Panel><EmptyState compact title={`${path} isn't in the project any more.`} /></Panel>;
  return <Panel><SkyEditor key={path} path={path} /></Panel>;
}

function SkyEditor({ path }: { path: string }) {
  const project = editor.project.current!;
  const doc = openAssetDocument<SkySettings>(project, path, "sky");
  const readOnly = doc.readOnly;
  const draft = doc.value.value;

  /** `drag`: a slider or colour drag under way (the SDK controls' commit rule, ADR 0282): its changes merge into one undo step, closed by the report that ends it. */
  const change = (next: SkySettings, drag = false) => doc.edit(next, drag ? { coalesce: true } : undefined);
  const applyPreset = (id: SkyPresetId) => doc.edit(skyPreset(id));

  const sun = sunAngles(draft);
  const light = skyLight(draft);

  return (
    // The frame (ADR 0265) is the head, Undo / Redo, problems and read-only notice above the two columns.
    <AssetDocumentFrame doc={doc} kind="Sky" class="sky-panel">
      <div class="sky-panel-columns">
        <div class="sky-panel-side">
          <LargePreview path={path} />
          <p class="sky-panel-readout" aria-label="Sun">
            Sun {sun.elevation.toFixed(1)}° up, {(((sun.azimuth % 360) + 360) % 360).toFixed(0)}° · lights with the {light.body} at {light.intensity.toFixed(2)}
          </p>
          <div class="sky-panel-actions">
            <select aria-label="Preset" disabled={readOnly} value="" onChange={(e) => (e.currentTarget as HTMLSelectElement).value && applyPreset((e.currentTarget as HTMLSelectElement).value as SkyPresetId)}>
              <option value="">Start from a preset…</option>
              {SKY_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div class="sky-panel-form">
          {SECTIONS.filter((s) => !s.when || s.when(draft)).map((s) => (
            <fieldset class="component sky-section" key={s.title}>
              <legend>{s.title}</legend>
              {s.fields.filter((f) => visible(f, draft)).map((f) => (
                <FieldRow key={f.path.join(".")} field={f} value={get(draft, f.path)} disabled={readOnly} onValue={(v, drag) => change(set(draft, f.path, v), drag)} />
              ))}
            </fieldset>
          ))}
          <fieldset class="component sky-section">
            <legend>Clouds</legend>
            {draft.clouds.map((layer, i) => (
              <div class="sky-cloud" key={i}>
                <div class="sky-cloud-head">
                  <span>Layer {i + 1}</span>
                  <button disabled={readOnly} aria-label={`Remove cloud layer ${i + 1}`} onClick={() => change({ ...cloneSky(draft), clouds: draft.clouds.filter((_, j) => j !== i) })}>
                    Remove
                  </button>
                </div>
                {CLOUD_FIELDS.map((f) => (
                  <FieldRow key={f.path.join(".")} field={{ ...f, label: f.label, path: ["clouds", i, ...f.path] }} prefix={`Cloud ${i + 1} `} value={get(layer, f.path)} disabled={readOnly} onValue={(v, drag) => change(set(draft, ["clouds", i, ...f.path], v), drag)} />
                ))}
              </div>
            ))}
            {draft.clouds.length < MAX_CLOUD_LAYERS && (
              <button disabled={readOnly} onClick={() => change({ ...cloneSky(draft), clouds: [...draft.clouds, defaultCloudLayer()] })}>
                Add cloud layer
              </button>
            )}
          </fieldset>
        </div>
      </div>
    </AssetDocumentFrame>
  );
}

/** Time-of-day fields hide in manual placement and vice versa; the phase hides when it comes from the date. */
function visible(f: Field, s: SkySettings): boolean {
  const key = f.path.join(".");
  if (s.sun.placement === "manual" && (key === "sun.timeOfDay" || key === "sun.latitude" || key === "sun.dayOfYear")) return false;
  if (s.sun.placement === "timeOfDay" && (key === "sun.elevation" || key === "sun.azimuth")) return false;
  if (s.moon.autoPhase && key === "moon.phase") return false;
  return true;
}

function FieldRow(props: { field: Field; value: unknown; disabled: boolean; prefix?: string; onValue: (v: unknown, drag?: boolean) => void }) {
  const { field: f, value, disabled, onValue } = props;
  const label = `${props.prefix ?? ""}${f.label}`;
  const hint = "hint" in f ? f.hint : undefined;
  switch (f.kind) {
    case "number":
      return (
        <label class="import-row sky-number" title={hint}>
          <span>{f.label}</span>
          <SliderField label={label} min={f.min} max={f.max} step={f.step} value={typeof value === "number" ? value : 0} disabled={disabled} onValue={onValue} />
        </label>
      );
    case "bool":
      return (
        <label class="import-row" title={hint}>
          <span>{f.label}</span>
          <input type="checkbox" aria-label={label} checked={value === true} disabled={disabled} onChange={(e) => onValue((e.currentTarget as HTMLInputElement).checked)} />
        </label>
      );
    case "color":
      return (
        <label class="import-row">
          <span>{f.label}</span>
          <ColorField label={label} value={typeof value === "string" ? value : "#000000"} disabled={disabled} onValue={onValue} />
        </label>
      );
    case "choice":
      return (
        <label class="import-row">
          <span>{f.label}</span>
          <select aria-label={label} value={String(value)} disabled={disabled} onChange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            onValue(typeof value === "number" ? Number(v) : v);
          }}>
            {f.options.map(([v, text]) => (
              <option key={v} value={v}>
                {text}
              </option>
            ))}
          </select>
        </label>
      );
    case "image":
      // The sky file stores the bare project path.
      return (
        <label class="import-row" title={hint}>
          <span>{f.label}</span>
          <AssetPicker label={label} kinds={["texture"]} stored="path" value={typeof value === "string" ? value : ""} disabled={disabled} onCommit={onValue} />
        </label>
      );
  }
}
