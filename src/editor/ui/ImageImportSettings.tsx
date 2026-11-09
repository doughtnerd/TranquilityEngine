// An image's import settings (ADR 0040, 0115, 0119) and its preview in the Inspector: the core
// `image` kind's `importSettings` (ADR 0143), loaded the first time an image is inspected. The shell's
// import Inspector (`AssetInspector.tsx`) owns the sidecar, Apply and Revert.
import { useState } from "preact/hooks";
import { IMPORT_PLATFORMS, TEXTURE_COMPRESSIONS, withPlatformOverride, type ImportPlatform, type ImportSettings, type PlatformOverrides } from "../../engine/scene/importSettings";
import { openSpriteEditor } from "../assetImport";
import type { ImportSettingsViewProps } from "../sdk/contributions";
import { PIVOT_PRESETS, pivotLabel } from "../spriteSlicing";
import { currentProject } from "../state";
import "./assetInspector.css";

/** The project's pixels per unit (100 by default, ADR 0014). */
const projectPPU = (settings: { render?: { pixelsPerUnit?: number } }) => settings.render?.pixelsPerUnit ?? 100;

const COMPRESSION_LABELS = { none: "None", low: "Low quality (smallest)", normal: "Normal quality", high: "High quality" } as const;
const PLATFORM_LABELS: Record<ImportPlatform, string> = { web: "Web", desktop: "Desktop" };
const parseMaxSize = (text: string) => {
  const v = Math.round(Number(text));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** Per-platform overrides of an image's settings (ADR 0115): "Same" inherits the value above; the current platform's are the ones used at load. */
function PlatformOverridesEditor(props: { draft: ImportSettings; onChange: (s: ImportSettings) => void }) {
  const { draft, onChange } = props;
  const put = <K extends keyof PlatformOverrides>(platform: ImportPlatform, key: K, value: PlatformOverrides[K] | undefined) => onChange(withPlatformOverride(draft, platform, key, value));
  const choice = <K extends "filter" | "wrap" | "compression">(platform: ImportPlatform, key: K, label: string, options: readonly (readonly [string, string])[]) => (
    <label class="import-row import-override">
      <span>{label}</span>
      <select
        aria-label={`${PLATFORM_LABELS[platform]} ${label}`}
        value={draft.platforms[platform]?.[key] ?? ""}
        onChange={(e) => put(platform, key, ((e.currentTarget as HTMLSelectElement).value || undefined) as PlatformOverrides[K] | undefined)}
      >
        <option value="">Same</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <details class="import-platforms" open={Object.keys(draft.platforms).length > 0}>
      <summary>Platform Overrides</summary>
      {IMPORT_PLATFORMS.map((platform) => {
        const o = draft.platforms[platform];
        return (
          <fieldset key={platform} class="import-platform" aria-label={`${PLATFORM_LABELS[platform]} overrides`}>
            <legend>{PLATFORM_LABELS[platform]}</legend>
            {choice(platform, "filter", "Filter Mode", [["linear", "Linear"], ["point", "Point"]])}
            {choice(platform, "wrap", "Wrap Mode", [["clamp", "Clamp"], ["repeat", "Repeat"], ["mirror", "Mirror"]])}
            <label class="import-row import-override">
              <span>Mipmaps</span>
              <select
                aria-label={`${PLATFORM_LABELS[platform]} Mipmaps`}
                value={o?.mipmaps === undefined ? "" : o.mipmaps ? "on" : "off"}
                onChange={(e) => put(platform, "mipmaps", ({ "": undefined, on: true, off: false } as const)[(e.currentTarget as HTMLSelectElement).value as "" | "on" | "off"])}
              >
                <option value="">Same</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label class="import-row import-override">
              <span>Max Size</span>
              <input
                type="number"
                min={0}
                aria-label={`${PLATFORM_LABELS[platform]} Max Size`}
                placeholder="Same"
                value={o?.maxSize ?? ""}
                onChange={(e) => {
                  const text = (e.currentTarget as HTMLInputElement).value;
                  put(platform, "maxSize", text.trim() === "" ? undefined : parseMaxSize(text));
                }}
              />
            </label>
            {choice(platform, "compression", "Compression", TEXTURE_COMPRESSIONS.map((c) => [c, COMPRESSION_LABELS[c]] as const))}
          </fieldset>
        );
      })}
    </details>
  );
}

/** The Import Settings card's rows for an image; Sprite Editor… opens once the draft is applied. */
export function ImageImportSettings(props: ImportSettingsViewProps) {
  const { path, project, draft, set, dirty } = props;
  return (
    <>
        <label class="import-row">
          <span>Pixels Per Unit</span>
          <input
            type="number"
            min={0}
            aria-label="Pixels Per Unit"
            placeholder={`Project (${projectPPU(project.settings)})`}
            value={draft.pixelsPerUnit > 0 ? draft.pixelsPerUnit : ""}
            onChange={(e) => {
              const v = Number((e.currentTarget as HTMLInputElement).value);
              set({ pixelsPerUnit: Number.isFinite(v) && v > 0 ? v : 0 });
            }}
          />
        </label>
        <label class="import-row">
          <span>Filter Mode</span>
          <select aria-label="Filter Mode" value={draft.filter} onChange={(e) => set({ filter: (e.currentTarget as HTMLSelectElement).value as ImportSettings["filter"] })}>
            <option value="linear">Linear (smooth)</option>
            <option value="point">Point (pixel art)</option>
          </select>
        </label>
        <label class="import-row">
          <span>Wrap Mode</span>
          <select aria-label="Wrap Mode" value={draft.wrap} onChange={(e) => set({ wrap: (e.currentTarget as HTMLSelectElement).value as ImportSettings["wrap"] })}>
            <option value="clamp">Clamp</option>
            <option value="repeat">Repeat</option>
            <option value="mirror">Mirror</option>
          </select>
        </label>
        <label class="import-row">
          <span>Generate Mipmaps</span>
          <input type="checkbox" aria-label="Generate Mipmaps" checked={draft.mipmaps} onChange={(e) => set({ mipmaps: (e.currentTarget as HTMLInputElement).checked })} />
        </label>
        <label class="import-row">
          <span>Max Size</span>
          <input
            type="number"
            min={0}
            step={1}
            aria-label="Max Size"
            title="Largest side in pixels (0 = no limit). Applied by game exports (ADR 0119): the build ships the image resized; the editor and play mode use the original."
            placeholder="No limit"
            value={draft.maxSize > 0 ? draft.maxSize : ""}
            onChange={(e) => set({ maxSize: parseMaxSize((e.currentTarget as HTMLInputElement).value) })}
          />
        </label>
        <label class="import-row">
          <span>Compression</span>
          <select
            aria-label="Compression"
            title="Applied by game exports (ADR 0119): low, normal and high re-encode the image as WebP (quality 90, 75, 50; lossless for point-filtered images). It shrinks the download, not GPU memory."
            value={draft.compression}
            onChange={(e) => set({ compression: (e.currentTarget as HTMLSelectElement).value as ImportSettings["compression"] })}
          >
            {TEXTURE_COMPRESSIONS.map((c) => (
              <option key={c} value={c}>
                {COMPRESSION_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <PlatformOverridesEditor draft={draft} onChange={props.replace} />
        <PivotRow pivot={draft.pivot} onChange={(pivot) => set({ pivot })} />
        <div class="import-row">
          <span>Sprites</span>
          <span class="import-sprites">
            <span class="import-count">{draft.sprites.length === 0 ? "Whole image" : `${draft.sprites.length} slice${draft.sprites.length === 1 ? "" : "s"}`}</span>
            <button
              disabled={dirty}
              title={dirty ? "Apply or revert these settings first" : "Slice the image into named sprites"}
              onClick={() => openSpriteEditor(path)}
            >
              Sprite Editor…
            </button>
          </span>
        </div>
    </>
  );
}

function PivotRow(props: { pivot: [number, number]; onChange: (pivot: [number, number]) => void }) {
  const { pivot, onChange } = props;
  const label = pivotLabel(pivot);
  const axis = (i: 0 | 1) => (
    <input
      type="number"
      step={0.05}
      aria-label={`Pivot ${i === 0 ? "X" : "Y"}`}
      value={pivot[i]}
      onChange={(e) => {
        const v = Number((e.currentTarget as HTMLInputElement).value);
        if (!Number.isFinite(v)) return;
        onChange(i === 0 ? [v, pivot[1]] : [pivot[0], v]);
      }}
    />
  );
  return (
    <div class="import-row">
      <span>Pivot</span>
      <span class="import-pivot">
        <select
          aria-label="Pivot"
          value={label}
          onChange={(e) => {
            const preset = PIVOT_PRESETS.find((p) => p.label === (e.currentTarget as HTMLSelectElement).value);
            if (preset) onChange([...preset.pivot]);
          }}
        >
          {PIVOT_PRESETS.map((p) => (
            <option key={p.label} value={p.label}>
              {p.label}
            </option>
          ))}
          {label === "Custom" && <option value="Custom">Custom</option>}
        </select>
        {axis(0)}
        {axis(1)}
      </span>
    </div>
  );
}

export { PivotRow };

/** The image itself, with its size in pixels. */
export function ImagePreview(props: { path: string }) {
  const url = currentProject.value?.assets.get(props.path);
  return <ImageView url={url} />;
}

function ImageView(props: { url: unknown }) {
  const [size, setSize] = useState<[number, number] | null>(null);
  if (typeof props.url !== "string") return null;
  return (
    <div class="asset-inspector-preview">
      <img src={props.url} alt="" draggable={false} onLoad={(e) => setSize([(e.currentTarget as HTMLImageElement).naturalWidth, (e.currentTarget as HTMLImageElement).naturalHeight])} />
      {size && (
        <span class="asset-inspector-size">
          {size[0]} × {size[1]} px
        </span>
      )}
    </div>
  );
}
