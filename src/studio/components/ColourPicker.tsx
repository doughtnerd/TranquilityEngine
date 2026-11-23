// The shared colour picker (owner spec §3.12, prototype `File.dc.html` marker inspector): preset swatches, the project's
// saved colours ("right-click to remove"), and a dashed + that opens Custom colour… — a floating popover anchored to it
// with a saturation/brightness square, a hue strip, a hex field, Save to swatches and Apply. Keys: arrows (Shift
// bigger steps) on the square and the strip, Page and Home/End on the strip, Enter applies, Escape closes. A
// fixed-colour item gets no picker (the owner doesn't draw one).
//
// Colours are CSS colour strings: a preset may be a theme token (`var(--accent)`), so Appearance themes it; custom and
// saved colours are "#rrggbb". The owner keeps the saved palette (one per project) and hands it in.
import { useRef, useState } from "preact/hooks";
import { usePopover } from "../../editor/ui/popover";
import { hexToHsv, hsvToHex, hueKey, readHex, removeColour, saveColour, svKey, type Hsv } from "./colourPickerModel";
import "./formControls.css";

export interface ColourPreset {
  readonly name: string;
  /** A CSS colour (a theme token such as `var(--warning)`, or "#rrggbb"). */
  readonly color: string;
}

/** The prototype's presets: amber, cyan, green, violet (theme tokens). */
export const DEFAULT_PRESETS: readonly ColourPreset[] = [
  { name: "Amber", color: "var(--warning)" },
  { name: "Cyan", color: "var(--accent)" },
  { name: "Green", color: "var(--accent2)" },
  { name: "Violet", color: "var(--series-6)" },
];

export interface ColourPickerProps {
  /** The current colour (null: none chosen, the item's default). */
  readonly value: string | null;
  /** The group's accessible name ("Marker colour"). */
  readonly label: string;
  readonly presets?: readonly ColourPreset[];
  /** The project's saved colours ("#rrggbb"). */
  readonly saved?: readonly string[];
  readonly disabled?: boolean;
  onChange(color: string): void;
  /** The saved palette changed (a colour saved or removed); absent hides Save and removing. */
  onSavedChange?(saved: string[]): void;
}

/** Where a custom colour starts when the current one isn't a hex (the prototype's blue). */
const START_HEX = "#6aa8ff";

export function ColourPicker(props: ColourPickerProps) {
  const presets = props.presets ?? DEFAULT_PRESETS;
  const saved = props.saved ?? [];
  const [open, setOpen] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  const swatch = (key: string, name: string, color: string, tip: string, onContext?: (e: MouseEvent) => void) => (
    <button
      key={key}
      type="button"
      class="studio-swatch"
      style={{ background: color }}
      aria-pressed={props.value === color}
      aria-label={name}
      title={tip}
      disabled={props.disabled}
      onClick={() => props.onChange(color)}
      onContextMenu={onContext}
    />
  );
  return (
    <div class="studio-colours" role="group" aria-label={props.label}>
      {presets.map((p) => swatch(`p:${p.name}`, p.name, p.color, p.name))}
      {saved.map((hex) =>
        swatch(`s:${hex}`, `Saved colour ${hex}`, hex, props.onSavedChange ? `${hex} · right-click to remove` : hex, props.onSavedChange ? (e) => (e.preventDefault(), props.onSavedChange!(removeColour(saved, hex))) : undefined),
      )}
      <button
        ref={plus}
        type="button"
        class="studio-swatch add"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Custom colour…"
        title="Custom colour…"
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
      >
        +
      </button>
      {open && (
        <CustomColour
          anchor={plus.current}
          start={readHex(props.value ?? "") ?? START_HEX}
          saved={saved}
          canSave={!!props.onSavedChange}
          onSave={(hex) => {
            props.onSavedChange?.(saveColour(saved, hex));
            props.onChange(hex);
          }}
          onApply={(hex) => {
            setOpen(false);
            props.onChange(hex);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function CustomColour(props: { anchor: HTMLElement | null; start: string; saved: readonly string[]; canSave: boolean; onSave(hex: string): void; onApply(hex: string): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  // The hue is kept apart from the hex, so a grey (saturation 0) doesn't lose it.
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(props.start));
  const [typed, setTyped] = useState<string | null>(null);
  const hex = hsvToHex(hsv);
  usePopover(ref, true, { anchor: props.anchor, align: "end", gap: 6, onDismiss: props.onClose, inside: [props.anchor] });
  const drag = (fn: (x: number, y: number) => void) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.focus({ preventScroll: true });
    el.setPointerCapture?.(e.pointerId);
    const r = el.getBoundingClientRect();
    const go = (ev: PointerEvent) => fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    go(e);
    const move = (ev: PointerEvent) => go(ev);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const isSaved = props.saved.includes(hex);
  return (
    <div
      ref={ref}
      class="studio-cpk"
      role="dialog"
      aria-label="Custom colour"
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const read = typed !== null ? readHex(typed) : null;
          props.onApply(read ?? hex);
        }
      }}
    >
      <div class="studio-cpk-head">
        <span class="studio-cpk-title">Custom colour</span>
        <button type="button" class="studio-cpk-close" aria-label="Close" title="Close (Esc)" onClick={props.onClose}>
          ×
        </button>
      </div>
      <div
        class="studio-cpk-sv"
        role="slider"
        tabIndex={0}
        autoFocus
        aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        title="Drag to pick saturation and brightness · ←→ saturation, ↑↓ brightness (Shift: bigger steps)"
        style={{ background: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
        onPointerDown={drag((x, y) => (setTyped(null), setHsv((c) => ({ ...c, s: x, v: 1 - y }))))}
        onKeyDown={(e) => {
          const next = svKey(hsv, e.key, e.shiftKey);
          if (!next) return;
          e.preventDefault();
          e.stopPropagation();
          setTyped(null);
          setHsv(next);
        }}
      >
        <span class="studio-cpk-white" aria-hidden="true" />
        <span class="studio-cpk-black" aria-hidden="true" />
        <span class="studio-cpk-dot" aria-hidden="true" style={{ left: `${(hsv.s * 100).toFixed(1)}%`, top: `${((1 - hsv.v) * 100).toFixed(1)}%`, background: hex }} />
      </div>
      <div
        class="studio-cpk-hue"
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        title="Drag to pick the hue · arrow keys nudge (Shift: bigger steps · Home/End: ends)"
        onPointerDown={drag((x) => (setTyped(null), setHsv((c) => ({ ...c, h: Math.min(359.9, x * 360) }))))}
        onKeyDown={(e) => {
          const h = hueKey(hsv.h, e.key, e.shiftKey);
          if (h === null) return;
          e.preventDefault();
          e.stopPropagation();
          setTyped(null);
          setHsv({ ...hsv, h });
        }}
      >
        <span class="studio-cpk-hue-thumb" aria-hidden="true" style={{ left: `${((hsv.h / 360) * 100).toFixed(1)}%`, background: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }} />
      </div>
      <div class="studio-cpk-row">
        <input
          class="studio-cpk-hex"
          type="text"
          aria-label="Hex value"
          spellcheck={false}
          value={typed ?? hex}
          onInput={(e) => setTyped((e.currentTarget as HTMLInputElement).value)}
          onChange={(e) => {
            const read = readHex((e.currentTarget as HTMLInputElement).value);
            setTyped(null);
            if (read) setHsv(hexToHsv(read));
          }}
        />
        <span class="studio-cpk-preview" aria-hidden="true" style={{ background: hex }} />
        {props.canSave && (
          <button type="button" class="studio-cpk-btn" disabled={isSaved} aria-label={isSaved ? "Saved" : "Save to swatches"} title={isSaved ? "Already in your swatches" : "Save to swatches (and apply): saved colours appear in every colour picker; right-click a saved swatch to remove it"} onClick={() => props.onSave(hex)}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
              <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
              <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
              <path d="M10.25 8.3v4M8.25 10.3h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        )}
      </div>
      <div class="studio-cpk-row end">
        <button type="button" class="studio-cpk-btn apply" aria-label="Apply" title="Apply this colour" onClick={() => props.onApply(hex)}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2.5 7.3 5.6 10.3 11.5 3.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
