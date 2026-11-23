// The Sequence toolbar's popovers (proto A13 `.pop`): Tempo (a BPM field, focused, "BPM", Tap and the meter on one row,
// then "No tempo", disabled without one) and Snap increment (the time display's three presets as radio items, a Custom
// row with its number and unit, then "Snap to edges"). Placed beside their button, kept in the window, closed by a press
// outside or Escape (`usePopover`), drawn at the page's floating root.
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import type { SequenceSettings } from "../../../../engine/audio/playlist/types";
import { FloatingPortal } from "../../../../editor/ui/FloatingPortal";
import { usePopover } from "../../../../editor/ui/popover";
import { Checkbox } from "../../../components/Checkbox";
import { customUnit, METERS, snapPresets, type SnapSetting } from "./sequenceGrid";

function Pop(props: { readonly anchor: Element; readonly label: string; readonly class?: string; onClose(): void; readonly children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  usePopover(ref, true, { anchor: props.anchor, onDismiss: props.onClose, inside: [props.anchor], align: "end" });
  return (
    <FloatingPortal>
      <div ref={ref} class={`sq-pop${props.class ? ` ${props.class}` : ""}`} role="dialog" aria-label={props.label}>
        {props.children}
      </div>
    </FloatingPortal>
  );
}

export interface TempoPopoverProps {
  readonly anchor: Element;
  readonly tempo: SequenceSettings["tempo"];
  readonly writable: boolean;
  readonly taps: number;
  onTempo(bpm: number | null): void;
  onTap(): void;
  onMeter(meter: string): void;
  onClose(): void;
}

export function TempoPopover(props: TempoPopoverProps) {
  const t = props.tempo;
  return (
    <Pop anchor={props.anchor} label="Tempo" class="sq-tempo-pop" onClose={props.onClose}>
      <div class="sq-pop-row">
        <input class="sq-num" aria-label="Tempo, BPM" placeholder="none" disabled={!props.writable} value={t?.bpm ?? ""} ref={(el) => {
            if (el && !el.dataset.focused) {
              el.dataset.focused = "1";
              el.focus();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            if (e.key === "Escape") (e.currentTarget as HTMLInputElement).value = String(t?.bpm ?? "");
          }}
          onChange={(e) => {
            const raw = (e.currentTarget as HTMLInputElement).value.trim();
            if (raw === "") return t && props.onTempo(null);
            const v = Number(raw);
            if (Number.isFinite(v) && v >= 20 && v <= 400) props.onTempo(v);
          }} />
        <span class="sq-unit">BPM</span>
        <button type="button" class="sq-btn" disabled={!props.writable} title="Tap on the beat two or more times; averages the last 8 taps, a pause over 2.5 s starts a new count" onClick={props.onTap}>
          Tap{props.taps > 1 ? ` ${props.taps}` : ""}
        </button>
        <select class="kit-select sq-meter" aria-label="Meter" disabled={!props.writable || !t} value={t?.meter ?? "4/4"} onChange={(e) => props.onMeter((e.currentTarget as HTMLSelectElement).value)}>
          {[...new Set([...METERS, t?.meter ?? "4/4"])].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div class="sq-psep" role="separator" />
      <button type="button" class="sq-tci" disabled={!props.writable || !t} onClick={() => { props.onTempo(null); props.onClose(); }}>No tempo</button>
    </Pop>
  );
}

export interface SnapPopoverProps {
  readonly anchor: Element;
  readonly snap: SnapSetting;
  readonly format: "timecode" | "samples" | "bars";
  readonly tempo: SequenceSettings["tempo"];
  onSnap(next: SnapSetting): void;
  onClose(): void;
}

export function SnapPopover(props: SnapPopoverProps) {
  const { snap, format } = props;
  const current = snap.mode === "off" ? snap.last : snap.mode;
  const unit = customUnit(format, props.tempo);
  const customValue = Math.round((snap.custom / unit.seconds) * 1000) / 1000;
  return (
    <Pop anchor={props.anchor} label="Snap increment" class="sq-snap-pop" onClose={props.onClose}>
      <div class="sq-pop-cap">Snap increment</div>
      {snapPresets(format).map((p) => (
        <button key={p.mode} type="button" role="menuitemradio" aria-checked={current === p.mode} class="sq-tci" onClick={() => props.onSnap({ ...snap, mode: p.mode, last: p.mode })}>
          <span class="sq-tci-check" aria-hidden="true">{current === p.mode ? "✓" : ""}</span>
          {p.label}
        </button>
      ))}
      <div class={`sq-tci sq-custom${current === "custom" ? " on" : ""}`}>
        <span class="sq-tci-check" aria-hidden="true">{current === "custom" ? "✓" : ""}</span>
        <button type="button" class="sq-link-btn" role="menuitemradio" aria-checked={current === "custom"} onClick={() => props.onSnap({ ...snap, mode: "custom", last: "custom" })}>Custom</button>
        <input class="sq-num" aria-label={`Custom snap, ${unit.unit}`} value={customValue}
          onChange={(e) => {
            const v = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v) && v > 0) props.onSnap({ ...snap, mode: "custom", last: "custom", custom: v * unit.seconds });
          }} />
        <span class="sq-unit">{unit.unit}</span>
      </div>
      <div class="sq-psep" role="separator" />
      <div class="sq-tci" title="Clip edges, loops and markers also snap to each other">
        <Checkbox checked={snap.edges} label="Snap to edges" onChange={(on) => props.onSnap({ ...snap, edges: on })} />
      </div>
    </Pop>
  );
}
