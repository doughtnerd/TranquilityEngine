// The Buses panel (ADR 0344; the prototype's Mixer board), the Mixer's fixed panel: the toolbar (Undo, Redo, History;
// the snapshot being edited with its trigger; the beds budget; Compare A|B; List|Strips; Collapse all; New bus), the
// routing tree as rows (drag a name onto another row to re-route; a horizontal fader with its meter and the VCA or
// base-level tick; the dB field; voices; bed; mute and solo), then Returns and VCAs, or the same buses as a console
// of vertical strips; and the live board of pinned buses. Every edit is one undo step of `audio.json`.
import { useEffect, useRef, useState } from "preact/hooks";
import { HistoryPopover } from "../../../editor/ui/HistoryPopover";
import { ContextMenu, SEPARATOR, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { Fader } from "../../components/Fader";
import { Icon } from "../../components/Icon";
import { busOf, kindOf, masterOf, reroute, routingRows, whyNotReroute } from "./busTree";
import { compareText } from "./liveMix";
import { editedSnapshot, labelOn, levelGhosts, levelLabel, setLevel, setMute, shownLevel } from "./mixEdits";
import type { MixerSession } from "./mixerScreen";
import { DbField, LiveMeter, MixFrame } from "./mixerViewParts";
import { startHolds, triggerText } from "./snapshotBlend";
import { openTriggerDialog } from "./TriggerDialog";
import { allocateBeds, bedText, voiceLimitOf } from "./voicesAndBeds";

type Menu = { at: { x: number; y: number }; name: string } | null;

/** A fader for `name` that edits its shown level (one coalesced undo step per drag). */
function LevelFader(props: { session: MixerSession; name: string; orientation?: "horizontal" | "vertical"; meter?: boolean }) {
  const { session, name } = props;
  const p = session.project.value;
  const editing = session.editing.value;
  const value = shownLevel(p, name, editing);
  const kind = kindOf(p, name);
  const auto = p.automation.some((a) => !a.bypass && a.on === name && a.target === "volume");
  return (
    <Fader
      value={value}
      orientation={props.orientation}
      label={`${name} level`}
      ghosts={levelGhosts(p, name, editing)}
      disabled={session.readOnly}
      title={auto ? "Level automation adds to this; open Automate ◆ in the Inspector" : undefined}
      onValue={(db, drag) => session.commit(setLevel(session.project.peek(), name, db, session.editing.peek()), levelLabel(session.project.peek(), name, session.editing.peek()), drag || undefined)}
    >
      {props.meter !== false && kind !== "vca" && <LiveMeter session={session} name={name} orientation={props.orientation} />}
    </Fader>
  );
}

function MuteSolo(props: { session: MixerSession; name: string; solo?: boolean }) {
  const { session, name } = props;
  const p = session.project.value;
  const muted = busOf(p, name)?.mute ?? p.returns.find((r) => r.name === name)?.mute ?? false;
  const soloed = session.soloed.value === name;
  return (
    <span class="mx-ms">
      <button class={`mx-toggle mute${muted ? " on" : ""}`} aria-pressed={muted} title={muted ? "Muted (saved): click to unmute" : "Mute (saved in the mix; silences the bus and its sends)"} disabled={session.readOnly} onClick={() => session.commit(setMute(session.project.peek(), name, !muted), labelOn(muted ? "Unmute" : "Mute", name))}>
        M
      </button>
      {props.solo !== false && (
        <button class={`mx-toggle solo${soloed ? " on" : ""}`} aria-pressed={soloed} title="Solo while you listen (never saved; marks the meters)" onClick={() => session.toggleSolo(name)}>
          S
        </button>
      )}
    </span>
  );
}

/** The toolbar's snapshot chip: what is being edited, whether it's on with the test values, and its trigger. */
function SnapshotChip(props: { session: MixerSession }) {
  const { session } = props;
  const p = session.project.value;
  const name = session.editing.value;
  const s = name === null ? null : p.snapshots.find((x) => x.name === name) ?? null;
  const on = s ? startHolds(s.start, p.parameters, session.testValues.value) : true;
  return (
    <span class={`mx-chip${s && editedSnapshot(p, name) ? " editing" : ""}`} title={s ? `Editing ${s.name}: ${triggerText(s.start)}` : "Editing the base mix"}>
      <span class={`mx-dot${on ? " on" : ""}`} role="img" aria-label={on ? "On with the test values" : "Off with the test values"} />
      <span class="mx-chip-name">{s ? s.name : "Base mix"}</span>
      {s && (
        <button class="mx-chip-button" onClick={() => openTriggerDialog(session, s.name)} aria-label={`Edit the trigger of ${s.name}`}>
          Trigger…
        </button>
      )}
    </span>
  );
}

function Toolbar(props: { session: MixerSession }) {
  const { session } = props;
  const p = session.project.value;
  const beds = allocateBeds(p);
  const live = session.live;
  void session.tick.value;
  const running = !!session.deps.live?.running();
  const compareOn = !!live?.compare.active;
  return (
    <div class="mx-toolbar" role="toolbar" aria-label="Mixer">
      <HistoryPopover none="Click into the mix to see its edit history" />
      <SnapshotChip session={session} />
      <span class={`mx-status${running ? " live" : ""}`} role="status" title={running ? "Edits play in the Studio's audio right away and are kept" : "Audition a playlist or replay a take to hear changes"}>
        {running ? "Live" : "Not playing"}
      </span>
      <span class={`mx-chip${beds.lost.length > 0 ? " warn" : ""}`} title={`Ambisonic beds: Master plus the ${Math.max(0, beds.maxBeds - 1)} highest bed priorities (Max beds is a project setting)`}>
        {beds.chip}
      </span>
      <span class="mx-spacer" />
      <span title={compareText(compareOn, !!live?.compare.available)}>
        <SegmentedControl
          label="Compare"
          size="small"
          value={compareOn ? "a" : "b"}
          options={[{ value: "a", label: "A", disabled: !live?.compare.available }, { value: "b", label: "B", disabled: !live?.compare.available }]}
          onChange={(v) => {
            if (!live || (v === "a") === live.compare.active) return;
            live.compare.toggle();
            session.tick.value++;
          }}
        />
      </span>
      <SegmentedControl label="View" size="small" value={session.view.value} options={[{ value: "list", label: "List" }, { value: "strips", label: "Strips" }]} onChange={(v) => (session.view.value = v)} />
      <button class="mx-tool" onClick={() => (session.collapsed.value = new Set(routingRows(p).filter((r) => r.depth === 1 && r.hasChildren).map((r) => r.name)))}>
        Collapse all
      </button>
      <button class="mx-tool primary" disabled={session.readOnly} onClick={() => session.newBus()} title={`New bus inside ${session.selected.value}`}>
        <Icon name="plus" /> New bus
      </button>
    </div>
  );
}

/** Drag a bus name onto another row to re-route it (4 px before it starts); refusals go to the status bar. */
function useRerouteDrag(session: MixerSession) {
  const [drag, setDrag] = useState<{ bus: string; over: string | null; started: boolean } | null>(null);
  const start = (e: PointerEvent, bus: string) => {
    if (e.button !== 0 || session.readOnly || bus === masterOf(session.project.peek())) return;
    const x0 = e.clientX, y0 = e.clientY;
    let state = { bus, over: null as string | null, started: false };
    const target = (ev: PointerEvent) => (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-bus-row]")?.dataset.busRow ?? null;
    const move = (ev: PointerEvent) => {
      if (!state.started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      state = { ...state, started: true, over: target(ev) };
      setDrag(state);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDrag(null);
      if (!state.started || ev.type === "pointercancel") return;
      const over = target(ev);
      if (!over || over === bus) return;
      const result = reroute(session.project.peek(), bus, over);
      if ("refused" in result) return session.deps.report("error", `Can't route ${bus} there: ${result.refused}`);
      session.commit(result, labelOn("Re-route", bus));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return { drag, start };
}

function RenameField(props: { value: string; label: string; onDone(value: string | null): void }) {
  const [text, setText] = useState(props.value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      class="mx-rename"
      value={text}
      aria-label={props.label}
      ref={ref}
      onInput={(e) => setText((e.target as HTMLInputElement).value)}
      onBlur={() => props.onDone(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") props.onDone(null);
        e.stopPropagation();
      }}
    />
  );
}

function menuFor(session: MixerSession, name: string, rename: () => void): MenuEntry[] {
  const p = session.project.peek();
  const kind = kindOf(p, name);
  const master = name === masterOf(p);
  const pinned = session.pins.peek().includes(name);
  return [
    ...(kind === "bus" ? [{ id: "child", label: "Add child bus", disabled: session.readOnly, run: () => { session.select(name); session.newBus(); } }] : []),
    { id: "rename", label: "Rename", hint: "F2", disabled: session.readOnly || master, title: master ? "Master keeps its name" : undefined, run: rename },
    ...(kind !== "vca" ? [{ id: "pin", label: pinned ? "Unpin from live board" : "Pin to live board", run: () => session.togglePin(name) }] : []),
    SEPARATOR,
    { id: "delete", label: "Delete…", hint: "Del", danger: true, disabled: session.readOnly || master, title: master ? "Master can't be deleted" : undefined, run: () => void session.remove(name) },
  ];
}

function ListView(props: { session: MixerSession }) {
  const { session } = props;
  const p = session.project.value;
  const rows = routingRows(p, session.collapsed.value);
  const beds = allocateBeds(p);
  const selected = session.selected.value;
  const [menu, setMenu] = useState<Menu>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const { drag, start } = useRerouteDrag(session);
  const doneRename = (from: string, to: string | null) => {
    setRenaming(null);
    if (to !== null && to !== from) void session.rename(from, to);
  };
  const nameCell = (name: string, draggable: boolean) =>
    renaming === name ? (
      <RenameField value={name} label={`Rename ${name}`} onDone={(v) => doneRename(name, v)} />
    ) : (
      <>
        {/* On a touch screen the name scrolls the list; the grip beside it re-routes (ADR 0361). */}
        {draggable && (
          <span class="mx-grip" aria-hidden="true" onPointerDown={(e) => start(e, name)} title="Drag onto another bus to re-route">
            <Icon name="grip" size={14} />
          </span>
        )}
        <span class={`mx-name${draggable ? " draggable" : ""}`} onPointerDown={draggable ? (e) => e.pointerType !== "touch" && start(e, name) : undefined} onDblClick={() => name !== masterOf(p) && !session.readOnly && setRenaming(name)} title={draggable ? `${name}: drag onto another bus to re-route` : name}>
          {name}
        </span>
      </>
    );
  const rowProps = (name: string) => ({
    class: `mx-row${selected === name ? " selected" : ""}`,
    "aria-selected": selected === name,
    tabIndex: selected === name ? 0 : -1,
    onClick: () => session.select(name),
    onContextMenu: (e: MouseEvent) => { e.preventDefault(); session.select(name); setMenu({ at: { x: e.clientX, y: e.clientY }, name }); },
    onKeyDown: (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, button, [role=slider]")) return;
      if (e.key === "F2" && name !== masterOf(p) && !session.readOnly) setRenaming(name);
      else if ((e.key === "Delete" || e.key === "Backspace") && name !== masterOf(p)) void session.remove(name);
    },
  });
  return (
    <div class="mx-list">
      <div class="mx-head" aria-hidden="true">
        <span>Routing</span><span>Level</span><span class="mx-col-db">dB</span><span class="mx-voices">Voices</span><span class="mx-bed">Bed</span><span>M S</span>
      </div>
      <div role="listbox" aria-label="Buses">
        {rows.map((r) => {
          const bus = busOf(p, r.name)!;
          const v = voiceLimitOf(p, r.name);
          const bed = beds.state.get(r.name);
          const over = drag?.started && drag.over === r.name;
          const refusal = over ? whyNotReroute(p, drag.bus, r.name) : null;
          return (
            <div key={r.name} role="option" data-bus-row={r.name} data-branch={r.branch ?? ""} {...rowProps(r.name)} class={`${rowProps(r.name).class}${over ? (refusal ? " drop-refused" : " drop-into") : ""}`} title={over && refusal ? `Can't route ${drag.bus} there: ${refusal}` : undefined}>
              <span class="mx-routing" style={{ paddingLeft: `${r.depth * 14}px` }}>
                {r.hasChildren ? (
                  <button class="mx-caret" aria-label={session.collapsed.value.has(r.name) ? `Expand ${r.name}` : `Collapse ${r.name}`} aria-expanded={!session.collapsed.value.has(r.name)} onClick={(e) => { e.stopPropagation(); const s = new Set(session.collapsed.value); if (s.has(r.name)) s.delete(r.name); else s.add(r.name); session.collapsed.value = s; }}>
                    <Icon name={session.collapsed.value.has(r.name) ? "chevronRight" : "chevronDown"} size={14} />
                  </button>
                ) : <span class="mx-caret-space" />}
                <span class="mx-stripe" />
                {nameCell(r.name, r.depth > 0)}
              </span>
              <LevelFader session={session} name={r.name} />
              <DbField value={shownLevel(p, r.name, session.editing.value)} label={`${r.name} level in dB`} disabled={session.readOnly} onCommit={(db) => session.commit(setLevel(session.project.peek(), r.name, db, session.editing.peek()), levelLabel(session.project.peek(), r.name, session.editing.peek()))} />
              <span class={`mx-voices${v.own ? "" : " inherited"}`} title={v.own ? `${v.limit} voices for ${r.name} and everything under it` : v.from ? `Shares ${v.from}'s limit` : "No voice limit"}>{v.text}</span>
              <span class={`mx-bed${bed?.kind === "lost" ? " warn" : ""}`}>{bedText(bed)}</span>
              <MuteSolo session={session} name={r.name} />
              {bus.mute && <span class="mx-sr">muted</span>}
            </div>
          );
        })}
      </div>
      {p.returns.length > 0 && <h3 class="mx-section">Returns</h3>}
      {p.returns.length > 0 && (
        <div role="listbox" aria-label="Returns">
          {p.returns.map((r) => (
            <div key={r.name} role="option" {...rowProps(r.name)}>
              <span class="mx-routing">{nameCell(r.name, false)}<span class="mx-faint"> → {r.output}</span></span>
              <LevelFader session={session} name={r.name} />
              <DbField value={shownLevel(p, r.name, session.editing.value)} label={`${r.name} level in dB`} disabled={session.readOnly} onCommit={(db) => session.commit(setLevel(session.project.peek(), r.name, db, session.editing.peek()), levelLabel(session.project.peek(), r.name, session.editing.peek()))} />
              <span class="mx-voices" /><span class="mx-bed" />
              <MuteSolo session={session} name={r.name} solo={false} />
            </div>
          ))}
        </div>
      )}
      <h3 class="mx-section">
        VCAs
        <button class="mx-tool" disabled={session.readOnly} onClick={() => session.newVca()}><Icon name="plus" /> VCA</button>
        <button class="mx-tool" disabled={session.readOnly} onClick={() => session.newReturn()}><Icon name="plus" /> Return</button>
      </h3>
      <div role="listbox" aria-label="VCAs">
        {p.vcas.map((v) => (
          <div key={v.name} role="option" {...rowProps(v.name)}>
            <span class="mx-routing">{nameCell(v.name, false)}</span>
            <LevelFader session={session} name={v.name} meter={false} />
            <DbField value={v.volumeDb} label={`${v.name} level in dB`} disabled={session.readOnly} onCommit={(db) => session.commit(setLevel(session.project.peek(), v.name, db, null), levelLabel(session.project.peek(), v.name, null))} />
            <span class="mx-faint mx-members" title={v.members.join(", ")}>{v.members.length === 0 ? "no members" : v.members.join(", ")}</span>
          </div>
        ))}
        {p.vcas.length === 0 && <p class="mx-note">A VCA offsets its member buses and everything under them, without audio passing through it.</p>}
      </div>
      {menu && <ContextMenu entries={menuFor(session, menu.name, () => setRenaming(menu.name))} at={menu.at} label={`${menu.name} menu`} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Strip(props: { session: MixerSession; name: string; compact?: boolean }) {
  const { session, name } = props;
  const p = session.project.value;
  const selected = session.selected.value === name;
  return (
    <div class={`mx-strip${selected ? " selected" : ""}${props.compact ? " compact" : ""}`} role="group" aria-label={name} onClick={() => session.select(name)} onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); session.select(name); } }} tabIndex={0}>
      <span class="mx-strip-name" title={name}>{name}</span>
      <div class="mx-strip-fader"><LevelFader session={session} name={name} orientation="vertical" /></div>
      <span class="mx-strip-db">{shownLevel(p, name, session.editing.value).toFixed(1)}</span>
      {kindOf(p, name) !== "vca" && <MuteSolo session={session} name={name} solo={kindOf(p, name) === "bus"} />}
    </div>
  );
}

function StripsView(props: { session: MixerSession }) {
  const { session } = props;
  const p = session.project.value;
  return (
    <div class="mx-strips" role="group" aria-label="Console">
      {routingRows(p).map((r) => <Strip key={r.name} session={session} name={r.name} />)}
      {p.returns.map((r) => <Strip key={r.name} session={session} name={r.name} />)}
    </div>
  );
}

/** The live board: up to 8 pinned buses as compact strips (a per-user preference), folded away by default. */
function LiveBoard(props: { session: MixerSession }) {
  const { session } = props;
  const pins = session.pins.value;
  const open = session.boardOpen.value;
  return (
    <section class="mx-board" aria-label="Live board">
      <button class="mx-board-head" aria-expanded={open} onClick={() => (session.boardOpen.value = !open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} /> Live board <span class="mx-faint">{pins.length}/8 pinned</span>
      </button>
      {open && (pins.length === 0 ? <p class="mx-note">Pin buses here from a row's menu (right-click) to keep them in reach while you listen.</p> : <div class="mx-board-strips">{pins.map((n) => <Strip key={n} session={session} name={n} compact />)}</div>)}
    </section>
  );
}

export function BusesPanel(props: { session: MixerSession }) {
  const { session } = props;
  const root = useRef<HTMLDivElement>(null);
  const p = session.project.value;
  return (
    <MixFrame session={session} class="mx-buses" label="Buses">
      <div ref={root} class="mx-buses-inner">
        <Toolbar session={session} />
        {p.buses.length === 1 && p.returns.length === 0 && (
          <p class="mx-note">Only Master so far. Add a bus for each kind of sound (music, effects, dialogue) so you can balance them.</p>
        )}
        {session.view.value === "list" ? <ListView session={session} /> : <StripsView session={session} />}
        <LiveBoard session={session} />
      </div>
    </MixFrame>
  );
}
