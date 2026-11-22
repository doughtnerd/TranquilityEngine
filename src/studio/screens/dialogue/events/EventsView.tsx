// The Dialogue screen's Events tab (ADR 0341 §7): the event list by file with search, add, duplicate, rename and
// delete; the selected event's settings (mode, priority, when busy, interrupt, wait, cooldown, chance, avoid repeat,
// skip missing, on interrupted); and its path table, test bench and coverage, passed in as children so each stays its
// own view. A view over props.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { FieldRow, NumberBox, SelectBox } from "../../../../editor/ui/PanelFields";
import { DIALOGUE_LIMITS } from "../../../../engine/audio/dialogue/format";
import type { DialogueEvent } from "../../../../engine/audio/dialogue/types";
import { InlineText } from "../LinesView";
import type { EventRef, EventSettings } from "./eventsModel";

export interface EventsViewProps {
  readonly events: readonly EventRef[];
  /** Dialogue files (where Add puts a new event: the selected event's file, else the first). */
  readonly files: readonly string[];
  readonly selected: EventRef | null;
  readonly search: string;
  readonly readOnly?: boolean;
  readonly children?: ComponentChildren;
  onSearch(q: string): void;
  onSelect(ref: EventRef): void;
  onAdd(file: string | null): void;
  onDuplicate(ref: EventRef): void;
  onRename(ref: EventRef, to: string): void;
  onDelete(ref: EventRef): void;
  onSettings(ref: EventRef, patch: Partial<EventSettings>, label: string): void;
}

function Settings(props: { event: DialogueEvent; names: readonly string[]; ro?: boolean; onSettings(patch: Partial<EventSettings>, label: string): void }) {
  const e = props.event;
  const set = props.onSettings;
  return (
    <details class="dl-section" aria-label="Event settings">
      <summary>Settings · {e.mode === "bestMatch" ? "best match" : "weighted"} · {e.whenBusy} · priority {e.priority ?? "from the line"}</summary>
      <div class="dl-row">
        <FieldRow label="Mode"><SelectBox label="Mode" value={e.mode} disabled={props.ro} options={[{ value: "bestMatch", label: "Best match" }, { value: "weighted", label: "Weighted" }]} onValue={(v) => set({ mode: v }, "Mode")} /></FieldRow>
        <FieldRow label="Priority" title="Empty: the line table's priority"><NumberBox label="Priority" value={e.priority ?? 50} min={0} max={100} step={1} digits={0} disabled={props.ro} onValue={(v) => set({ priority: v }, "Priority")} /></FieldRow>
        <FieldRow label="When busy"><SelectBox label="When busy" value={e.whenBusy} disabled={props.ro} options={[{ value: "queue", label: "Queue" }, { value: "interrupt", label: "Interrupt" }, { value: "drop", label: "Drop" }]} onValue={(v) => set({ whenBusy: v }, "When busy")} /></FieldRow>
        <FieldRow label="May interrupt"><SelectBox label="May interrupt" value={e.interrupt} disabled={props.ro} options={[{ value: "never", label: "Never" }, { value: "lower", label: "Lower priority" }, { value: "always", label: "Always" }]} onValue={(v) => set({ interrupt: v }, "Interrupt")} /></FieldRow>
        <FieldRow label="Max wait" unit="s"><NumberBox label="Max wait" value={e.maxWait} min={0} max={DIALOGUE_LIMITS.seconds} step={0.5} digits={1} disabled={props.ro} onValue={(v) => set({ maxWait: v }, "Max wait")} /></FieldRow>
        <FieldRow label="Cooldown" unit="s"><NumberBox label="Event cooldown" value={e.cooldown} min={0} max={DIALOGUE_LIMITS.seconds} step={0.5} digits={1} disabled={props.ro} onValue={(v) => set({ cooldown: v }, "Cooldown")} /></FieldRow>
        <FieldRow label="Chance" unit="%"><NumberBox label="Chance" value={e.chance * 100} min={0} max={100} step={5} digits={0} disabled={props.ro} onValue={(v) => set({ chance: v / 100 }, "Chance")} /></FieldRow>
        <FieldRow label="Avoid repeat"><NumberBox label="Avoid repeat" value={e.avoidRepeat} min={0} max={DIALOGUE_LIMITS.avoidRepeat} step={1} digits={0} disabled={props.ro} onValue={(v) => set({ avoidRepeat: Math.round(v) }, "Avoid repeat")} /></FieldRow>
        <FieldRow label="Skip missing" title="A line with no file in the language's chain isn't picked"><input type="checkbox" aria-label="Skip missing" checked={e.skipMissing} disabled={props.ro} onChange={(ev) => set({ skipMissing: (ev.currentTarget as HTMLInputElement).checked }, "Skip missing")} /></FieldRow>
        <FieldRow label="On interrupted"><SelectBox label="On interrupted" value={e.onInterrupted ?? ""} disabled={props.ro} options={[{ value: "", label: "Nothing" }, ...props.names.filter((n) => n !== e.name).map((n) => ({ value: n, label: n }))]} onValue={(v) => set({ onInterrupted: v || null }, "On interrupted")} /></FieldRow>
      </div>
    </details>
  );
}

export function EventsView(props: EventsViewProps) {
  const sel = props.selected;
  const [confirm, setConfirm] = useState(false);
  let lastFile = "";
  return (
    <div class="dl-events">
      <div>
        <div class="dl-toolbar">
          <input type="search" aria-label="Search events" placeholder="Search events" value={props.search} onInput={(e) => props.onSearch((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <div class="dl-toolbar">
          <button disabled={props.readOnly} title={props.files.length === 0 ? "Creates dialogue/events.dialogue.json" : undefined} onClick={() => props.onAdd(sel?.path ?? props.files[0] ?? null)}>Add event</button>
          <button disabled={props.readOnly || !sel} onClick={() => sel && props.onDuplicate(sel)}>Duplicate</button>
          {confirm && sel ? (
            <button class="danger" onClick={() => { props.onDelete(sel); setConfirm(false); }}>Delete {sel.event.name}?</button>
          ) : (
            <button disabled={props.readOnly || !sel} onClick={() => setConfirm(true)}>Delete</button>
          )}
        </div>
        <ul class="dl-event-list" aria-label="Events">
          {props.events.length === 0 && <li class="dl-muted">{props.search ? "No event matches." : "No dialogue events yet."}</li>}
          {props.events.map((r) => {
            const head = r.path !== lastFile ? ((lastFile = r.path), <li key={`f${r.path}`} class="dl-event-file" aria-hidden="true">{r.path}</li>) : null;
            const on = sel?.path === r.path && sel.event.name === r.event.name;
            return [head, <li key={`${r.path}#${r.event.name}`}><button class={on ? "on" : undefined} aria-current={on ? "true" : undefined} onClick={() => { setConfirm(false); props.onSelect(r); }}>{r.event.name}</button></li>];
          })}
        </ul>
      </div>
      <div>
        {sel ? (
          <>
            <div class="dl-row">
              <InlineText value={sel.event.name} label="Event name" class="dl-key" disabled={props.readOnly} onCommit={(v) => props.onRename(sel, v.trim())} />
              <span class="dl-muted">{sel.path}</span>
            </div>
            <Settings event={sel.event} names={props.events.map((r) => r.event.name)} ro={props.readOnly} onSettings={(patch, label) => props.onSettings(sel, patch, label)} />
            {props.children}
          </>
        ) : (
          <p class="dl-note">Select an event, or add one: an event picks a line from its arguments (Wwise's dynamic dialogue).</p>
        )}
      </div>
    </div>
  );
}
