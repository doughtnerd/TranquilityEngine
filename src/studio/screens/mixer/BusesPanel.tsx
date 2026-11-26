// The Buses panel (ADR 0344; the prototype's Mixer board), the Mixer's fixed panel: the toolbar (Undo, Redo, History;
// the snapshot being edited with its trigger summary; "Live" or the edits kept after the game session stopped, or the
// re-route drag's hint; the beds budget; Compare A|B; List|Strips; Collapse all; New bus), the routing tree as rows
// (each bus's branch colour and meta; drag a name onto another row to re-route; a horizontal fader with its meter and
// the VCA or base-level tick; the dB field with the level its VCAs land it at; voices; bed; mute and solo), then
// Returns and VCAs, or the same buses as a console of vertical strips (colour top, kind, meter and fader, typed dB,
// LUFS, voices, M S); and the live board of pinned buses. Every edit is one undo step of `audio.json`.
import { useEffect, useRef, useState } from "preact/hooks";
import { ContextMenu, SEPARATOR, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { HistoryPopover } from "../../../editor/ui/HistoryPopover";
import { InfoTip } from "../../../editor/ui/InfoTip";
import { MoveToDialog } from "../../../editor/ui/MoveToDialog";
import { Fader } from "../../components/Fader";
import { formatDb } from "../../components/faderModel";
import { Icon } from "../../components/Icon";
import { busColour, dragHint, rowMeta, stripKind } from "./busRows";
import { busFolders, busOf, kindOf, masterOf, reroute, routingRows, whyNotReroute } from "./busTree";
import { compareText } from "./liveMix";
import { editedSnapshot, labelOn, levelGhosts, levelLabel, setLevel, setMute, shownLevel } from "./mixEdits";
import type { MixerSession } from "./mixerScreen";
import { DbField, LiveMeter, MixFrame, undoEntry } from "./mixerViewParts";
import { startHolds, triggerSummary, triggerText } from "./snapshotBlend";
import { openTriggerDialog } from "./TriggerDialog";
import { allocateBeds, bedCell, bedsTitle, bedTitle, voiceLimitOf } from "./voicesAndBeds";

type Menu = { at: { x: number; y: number }; name: string } | null;
type Drag = { bus: string; over: string | null; started: boolean } | null;

/** A fader for `name` that edits its shown level (one coalesced undo step per drag). */
function LevelFader(props: { session: MixerSession; name: string; orientation?: "horizontal" | "vertical"; meter?: boolean; label?: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const editing = session.editing.value;
  const value = shownLevel(p, name, editing);
  const kind = kindOf(p, name);
  const auto = p.automation.some((a) => !a.bypass && a.on === name && a.target === "volume");
  // Fader and Meter default to different orientations, so the meter takes the fader's, resolved here.
  const orientation = props.orientation ?? "horizontal";
  return (
    <Fader
      value={value}
      orientation={orientation}
      label={props.label ?? `${name} level`}
      ghosts={levelGhosts(p, name, editing)}
      disabled={session.readOnly}
      selected={session.selected.value === name}
      title={auto ? "Level automation adds to this; open Automate in the Inspector" : `Drag to set the level · double-click for 0 dB (${formatDb(value)} dB)`}
      onValue={(db, drag) => session.commit(setLevel(session.project.peek(), name, db, session.editing.peek()), levelLabel(session.project.peek(), name, session.editing.peek()), drag || undefined)}
    >
      {props.meter !== false && kind !== "vca" && <LiveMeter session={session} name={name} orientation={orientation} />}
    </Fader>
  );
}

/** The dB field, with the level its VCAs land it at under it in violet ("→ −10 dB"). */
function LevelCell(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const editing = session.editing.value;
  const vca = levelGhosts(p, name, editing).find((g) => g.kind === "vca");
  return (
    <span class="mx-dbcell">
      <DbField value={shownLevel(p, name, editing)} label={`${name} level in dB`} disabled={session.readOnly} title="Type a level in dB (−60 to +6)" onCommit={(db) => session.commit(setLevel(session.project.peek(), name, db, session.editing.peek()), levelLabel(session.project.peek(), name, session.editing.peek()))} />
      {vca && <span class="mx-vca-now" title={`${vca.title}: the fader stays where you set it`}>→ {formatDb(vca.db)} dB</span>}
    </span>
  );
}

function MuteSolo(props: { session: MixerSession; name: string; solo?: boolean; disabled?: boolean }) {
  const { session, name } = props;
  const p = session.project.value;
  const muted = busOf(p, name)?.mute ?? p.returns.find((r) => r.name === name)?.mute ?? false;
  const soloed = session.soloed.value === name;
  return (
    <span class="mx-ms">
      <button class={`mx-toggle mute${muted ? " on" : ""}`} aria-pressed={muted} aria-label={`Mute ${name}`} title={props.disabled ? "A VCA has no audio to mute" : muted ? "Muted (saved): click to unmute" : "Mute (saved in the mix; silences the bus and its sends)"} disabled={session.readOnly || props.disabled} onClick={(e) => { e.stopPropagation(); session.commit(setMute(session.project.peek(), name, !muted), labelOn(muted ? "Unmute" : "Mute", name)); }}>
        M
      </button>
      <button class={`mx-toggle solo${soloed ? " on" : ""}`} aria-pressed={soloed} aria-label={`Solo ${name}`} title={props.solo === false ? "Solo works on buses" : "Solo while you listen (never saved; marks the meters)"} disabled={props.solo === false || props.disabled} onClick={(e) => { e.stopPropagation(); session.toggleSolo(name); }}>
        S
      </button>
    </span>
  );
}

/** The toolbar's snapshot chip: what is being edited, whether it's on with the test values, and its trigger (opens the dialog). */
function SnapshotChip(props: { session: MixerSession }) {
  const { session } = props;
  const p = session.project.value;
  const name = session.editing.value;
  const s = name === null ? null : p.snapshots.find((x) => x.name === name) ?? null;
  const on = s ? startHolds(s.start, p.parameters, session.testValues.value) : true;
  const what = s ? s.name : "Base mix";
  const chipTitle = s ? `Editing ${s.name} · ${on ? "active now: its trigger is true" : "not active now"}${editedSnapshot(p, name) ? " · its levels apply on top of the base mix" : ""}` : "Editing the base mix: the levels every snapshot applies on top of";
  return (
    <span class="mx-snc" title={chipTitle}>
      <span class={`mx-dot${on ? " on" : ""}`} role="img" aria-label={on ? "Active with the test values" : "Not active with the test values"} />
      <span class="mx-snc-name">{what}</span>
      {s ? (
        <button class="mx-sntr" onClick={() => openTriggerDialog(session, s.name)} aria-label={`Trigger of ${s.name}: ${triggerText(s.start, p.parameters)}`} title={`Trigger: what makes ${s.name} active in the game · click to edit (${triggerText(s.start, p.parameters)})`}>
          <Icon name="trigger" size={11} />
          <span class="mx-sntr-text">{triggerSummary(s.start, p.parameters)}</span>
          <Icon name="chevronDown" size={11} />
        </button>
      ) : (
        <span class="mx-sntr quiet" title="The base mix is always on">
          <Icon name="trigger" size={11} />
          <span class="mx-sntr-text">Always on</span>
        </span>
      )}
    </span>
  );
}

/** "Live" while the game session plays, "N edits kept" after it stops, or the re-route drag's hint. */
function LiveText(props: { session: MixerSession; drag: Drag }) {
  const { session, drag } = props;
  const p = session.project.value;
  if (drag?.started) {
    const refusal = drag.over && drag.over !== drag.bus ? whyNotReroute(p, drag.bus, drag.over) : null;
    const hint = dragHint(drag.bus, drag.over, refusal);
    return <span class={`mx-status${hint.refused ? " warn" : " hint"}`} role="status">{hint.text}</span>;
  }
  const live = session.sessionLive();
  const kept = session.liveEdits.value;
  if (live) return <span class="mx-status live" role="status" title="Mixing while the game plays. Edits stay after Stop.">Live</span>;
  if (kept > 0) return <span class="mx-status" role="status" title="Edits you made while the game played are kept after Stop">{kept} edit{kept === 1 ? "" : "s"} kept</span>;
  return null;
}

function Toolbar(props: { session: MixerSession; drag: Drag; onCreated(name: string | null): void }) {
  const { session } = props;
  const p = session.project.value;
  const beds = allocateBeds(p);
  const live = session.live;
  void session.tick.value;
  const compareOn = !!live?.compare.active;
  const canCompare = !!live?.compare.available;
  const compare = (a: boolean) => {
    if (!live || a === live.compare.active) return;
    live.compare.toggle();
    session.tick.value++;
  };
  const view = session.view.value;
  return (
    <div class="mx-toolbar" role="toolbar" aria-label="Mixer">
      <HistoryPopover none="Click into the mix to see its edit history" />
      <SnapshotChip session={session} />
      <LiveText session={session} drag={props.drag} />
      <span class={`mx-beds${beds.lost.length > 0 ? " warn" : ""}`} title={bedsTitle(beds)}>
        {beds.chip}
      </span>
      <span class="mx-spacer" />
      <span class="mx-msgroup" role="group" aria-label="Compare" title={canCompare ? undefined : compareText(false, false)}>
        <button class={`mx-msb${compareOn ? " on" : ""}`} aria-pressed={compareOn} disabled={!canCompare} title="A · hear the saved mix; your live edits are held, not lost" onClick={() => compare(true)}>A</button>
        <button class={`mx-msb${canCompare && !compareOn ? " on" : ""}`} aria-pressed={canCompare && !compareOn} disabled={!canCompare} title="B · hear your live edits" onClick={() => compare(false)}>B</button>
      </span>
      <span class="mx-msgroup" role="group" aria-label="View">
        <button class={`mx-msb icon${view === "list" ? " on" : ""}`} aria-pressed={view === "list"} aria-label="List" title="List: routing tree" onClick={() => (session.view.value = "list")}><Icon name="menu" size={14} /></button>
        <button class={`mx-msb icon${view === "strips" ? " on" : ""}`} aria-pressed={view === "strips"} aria-label="Strips" title="Strips: console faders, in routing order" onClick={() => (session.view.value = "strips")}><Icon name="mixer" size={14} /></button>
      </span>
      <button class="kit-icon-button mx-cib" aria-label="Collapse all" title="Collapse all buses (top-level buses stay visible)" onClick={() => (session.collapsed.value = new Set(routingRows(p).filter((r) => r.depth === 1 && r.hasChildren).map((r) => r.name)))}>
        <Icon name="collapse" size={14} />
      </button>
      <button class="kit-icon-button mx-cib" aria-label="New bus" disabled={session.readOnly} onClick={() => props.onCreated(session.newBus())} title={`New bus (inside the selected one: ${session.selected.value})`}>
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}

/** Drag a bus name onto another row to re-route it (4 px before it starts); refusals go to the status bar. */
function useRerouteDrag(session: MixerSession) {
  const [drag, setDrag] = useState<Drag>(null);
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
      if (session.commit(result, labelOn("Re-route", bus)) && session.collapsed.peek().has(over)) {
        const s = new Set(session.collapsed.peek());
        s.delete(over);
        session.collapsed.value = s;
      }
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

function menuFor(session: MixerSession, name: string, rename: (() => void) | null, moveTo: () => void, onCreated: (name: string | null) => void = () => {}): MenuEntry[] {
  const p = session.project.peek();
  const kind = kindOf(p, name);
  const master = name === masterOf(p);
  const pinned = session.pins.peek().includes(name);
  const noun = kind === "return" ? "return" : kind === "vca" ? "VCA" : "bus";
  return [
    ...(kind === "bus" ? [{ id: "child", label: "Add child bus", disabled: session.readOnly, run: () => { session.select(name); onCreated(session.newBus()); } }] : []),
    { id: "rename", label: "Rename", hint: "F2", disabled: session.readOnly || master || !rename, title: master ? "Master keeps its name" : rename ? undefined : "Rename it in the Inspector", run: () => rename?.() },
    ...(kind === "bus" ? [{ id: "move", label: "Move to…", disabled: session.readOnly || master, title: master ? "Master can't be re-routed" : "Pick the bus it feeds (as dragging it does)", run: moveTo }] : []),
    ...(kind !== "vca" ? [{ id: "pin", label: pinned ? "Unpin from live board" : "Pin to live board", run: () => session.togglePin(name) }] : []),
    SEPARATOR,
    undoEntry(),
    SEPARATOR,
    { id: "delete", label: `Delete ${noun}…`, hint: "Del", danger: true, disabled: session.readOnly || master, title: master ? "Master can't be deleted" : kind === "bus" ? "Its children move up to its parent" : undefined, run: () => void session.remove(name) },
  ];
}

/** The tree cell: fold caret, colour bar, name, and the meta at the right. */
function TreeCell(props: { session: MixerSession; name: string; depth: number; hasChildren?: boolean; draggable: boolean; renaming: boolean; onRename(v: string | null): void; onDragStart(e: PointerEvent): void; onStartRename(): void }) {
  const { session, name, depth } = props;
  const p = session.project.value;
  const folded = session.collapsed.value.has(name);
  const meta = rowMeta(p, name, folded);
  const master = name === masterOf(p);
  return (
    <span class="mx-routing" style={{ paddingLeft: `${depth * 16}px` }}>
      {props.hasChildren ? (
        <button class="mx-caret" aria-label={folded ? `Expand ${name}` : `Collapse ${name}`} title={folded ? `Expand ${name}` : `Collapse ${name}`} aria-expanded={!folded} onClick={(e) => { e.stopPropagation(); const s = new Set(session.collapsed.value); if (s.has(name)) s.delete(name); else s.add(name); session.collapsed.value = s; }}>
          <Icon name={folded ? "chevronRight" : "chevronDown"} size={12} />
        </button>
      ) : <span class="mx-caret-space" />}
      <span class="mx-stripe" style={{ background: busColour(p, name) }} aria-hidden="true" />
      {props.renaming ? (
        <RenameField value={name} label={`Rename ${name}`} onDone={props.onRename} />
      ) : (
        <>
          {/* On a touch screen the name scrolls the list; the grip beside it re-routes (ADR 0361). */}
          {props.draggable && (
            <span class="mx-grip" aria-hidden="true" onPointerDown={props.onDragStart} title="Drag onto another bus to re-route">
              <Icon name="grip" size={14} />
            </span>
          )}
          <span
            class={`mx-name${props.draggable ? " draggable" : ""}${depth <= 1 ? " top" : ""}`}
            onPointerDown={props.draggable ? (e) => e.pointerType !== "touch" && props.onDragStart(e) : undefined}
            onDblClick={() => !master && !session.readOnly && props.onStartRename()}
            title={master ? `${name}: the output. Everything ends here.` : props.draggable ? `${name} · drag the name to re-route` : name}
          >
            {name}
          </span>
        </>
      )}
      {meta.text && <span class="mx-meta" title={meta.title}>{meta.text}</span>}
    </span>
  );
}

function ListView(props: { session: MixerSession; drag: Drag; startDrag(e: PointerEvent, bus: string): void; menu: Menu; setMenu(m: Menu): void; renaming: string | null; setRenaming(name: string | null): void }) {
  const { session, drag } = props;
  const p = session.project.value;
  const rows = routingRows(p, session.collapsed.value);
  const beds = allocateBeds(p);
  const selected = session.selected.value;
  const master = masterOf(p);
  const { renaming, setRenaming } = props;
  const [moving, setMoving] = useState<string | null>(null);
  const doneRename = (from: string, to: string | null) => {
    setRenaming(null);
    if (to !== null && to !== from) void session.rename(from, to);
  };
  const rowProps = (name: string) => ({
    class: `mx-row${selected === name ? " selected" : ""}${drag?.started && drag.bus === name ? " dragging" : ""}`,
    "aria-selected": selected === name,
    tabIndex: selected === name ? 0 : -1,
    onClick: () => session.select(name),
    onContextMenu: (e: MouseEvent) => { e.preventDefault(); session.select(name); props.setMenu({ at: { x: e.clientX, y: e.clientY }, name }); },
    onKeyDown: (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, button, [role=slider]")) return;
      if (e.key === "F2" && name !== master && !session.readOnly) setRenaming(name);
      else if ((e.key === "Delete" || e.key === "Backspace") && name !== master) void session.remove(name);
    },
  });
  const cell = (name: string, depth: number, draggable: boolean, hasChildren?: boolean) => (
    <TreeCell session={session} name={name} depth={depth} hasChildren={hasChildren} draggable={draggable} renaming={renaming === name} onRename={(v) => doneRename(name, v)} onDragStart={(e) => props.startDrag(e, name)} onStartRename={() => setRenaming(name)} />
  );
  return (
    <div class="mx-list">
      <div class="mx-head" aria-hidden="true">
        <span>Routing</span><span>Level</span><span class="mx-col-db">dB</span><span class="mx-voices">Voices</span><span class="mx-bed" title="Which ambisonic bed this bus's distant sounds are mixed into">Bed</span><span />
      </div>
      <div role="listbox" aria-label="Buses">
        {rows.map((r) => {
          const bus = busOf(p, r.name)!;
          const v = voiceLimitOf(p, r.name);
          const bed = beds.state.get(r.name);
          const over = drag?.started && drag.over === r.name && drag.bus !== r.name;
          const refusal = over ? whyNotReroute(p, drag.bus, r.name) : null;
          const rp = rowProps(r.name);
          return (
            <div key={r.name} role="option" data-bus-row={r.name} {...rp} class={`${rp.class}${over ? (refusal ? " drop-refused" : " drop-into") : ""}`} title={over && refusal ? `Can't route ${drag.bus} there: ${refusal}` : undefined}>
              {cell(r.name, r.depth, r.depth > 0, r.hasChildren)}
              <LevelFader session={session} name={r.name} />
              <LevelCell session={session} name={r.name} />
              <span class={`mx-voices${v.own ? "" : " inherited"}`} title={v.own ? `Caps every sequence routed into ${r.name} or any bus under it` : v.from ? `No cap here; shares ${v.from}'s limit of ${v.limit}` : `No bus voice cap: only the project's ${p.settings.voices.mixed} mixed voices limit how many play at once`}>{v.text}</span>
              <span class={`mx-bed${bed?.kind === "lost" ? " warn" : bed?.kind === "own" ? " own" : ""}`} title={bedTitle(bed, r.name === master, beds.maxBeds)}>{bedCell(bed, r.name === master)}</span>
              <MuteSolo session={session} name={r.name} />
              {bus.mute && <span class="mx-sr">muted</span>}
            </div>
          );
        })}
      </div>
      <h3 class="mx-section">
        Returns <InfoTip text="Returns are fed by sends: a bus copies its signal to one after its fader. A return mixes them and outputs to its bus." label="About returns" />
        <button class="kit-icon-button mx-cib" aria-label="New return" title="New return" disabled={session.readOnly} onClick={() => setRenaming(session.newReturn())}><Icon name="plus" size={14} /></button>
      </h3>
      {p.returns.length > 0 ? (
        <div role="listbox" aria-label="Returns">
          {p.returns.map((r) => (
            <div key={r.name} role="option" {...rowProps(r.name)}>
              {cell(r.name, 0, false)}
              <LevelFader session={session} name={r.name} />
              <LevelCell session={session} name={r.name} />
              <span class="mx-voices inherited">—</span>
              <span class="mx-bed inherited" title={`Outputs to ${r.output}`}>→ {r.output}</span>
              <MuteSolo session={session} name={r.name} solo={false} />
            </div>
          ))}
        </div>
      ) : <p class="mx-note">No returns.</p>}
      <h3 class="mx-section">
        VCAs <InfoTip text="VCAs offset their members' levels; the member faders stay put and no audio runs through a VCA." label="About VCAs" />
        <button class="kit-icon-button mx-cib" aria-label="New VCA" title="New VCA" disabled={session.readOnly} onClick={() => setRenaming(session.newVca())}><Icon name="plus" size={14} /></button>
      </h3>
      {p.vcas.length > 0 ? (
        <div role="listbox" aria-label="VCAs">
          {p.vcas.map((v) => (
            <div key={v.name} role="option" {...rowProps(v.name)}>
              {cell(v.name, 0, false)}
              <LevelFader session={session} name={v.name} meter={false} />
              <LevelCell session={session} name={v.name} />
              <span class="mx-voices inherited">—</span>
              <span class="mx-bed inherited">—</span>
              <MuteSolo session={session} name={v.name} disabled />
            </div>
          ))}
        </div>
      ) : <p class="mx-note">No VCAs.</p>}
      {props.menu && <ContextMenu entries={menuFor(session, props.menu.name, () => setRenaming(props.menu!.name), () => setMoving(props.menu!.name), setRenaming)} at={props.menu.at} label={`${props.menu.name} menu`} onClose={() => props.setMenu(null)} />}
      {moving && <MoveBusDialog session={session} name={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}

/** "Move to…" on a bus: the shared Move to… dialog over the routing tree; picking a bus re-routes to it (one undo step). */
function MoveBusDialog(props: { session: MixerSession; name: string; onClose(): void }) {
  const { session, name } = props;
  const p = session.project.value;
  const tree = busFolders(p);
  return (
    <MoveToDialog
      items={[{ path: tree.pathOf(name), folder: true }]}
      folders={tree.folders}
      noun="bus"
      rootName={masterOf(p)}
      onMove={(path) => {
        props.onClose();
        const parent = tree.busAt(path);
        if (parent) session.commit(reroute(session.project.peek(), name, parent), labelOn("Re-route", name));
      }}
      onCancel={props.onClose}
    />
  );
}

/** A console strip: colour top, name, kind, meter beside a vertical fader, typed dB, LUFS, voices, M S. */
function Strip(props: { session: MixerSession; name: string; compact?: boolean; onMenu?(e: MouseEvent): void }) {
  const { session, name } = props;
  const p = session.project.value;
  const selected = session.selected.value === name;
  const kind = kindOf(p, name);
  const v = kind === "bus" ? voiceLimitOf(p, name) : null;
  void session.tick.value;
  const loud = kind === "vca" ? null : (session.deps.readLoudness?.(name) ?? null);
  const lufs = loud && Number.isFinite(loud.shortTerm) ? `${formatDb(loud.shortTerm)} LUFS` : "— LUFS";
  return (
    <div
      class={`mx-strip${selected ? " selected" : ""}${props.compact ? " compact" : ""}`}
      style={{ borderTopColor: busColour(p, name) }}
      role="group"
      aria-label={name}
      onClick={() => session.select(name)}
      onContextMenu={props.onMenu}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); session.select(name); } }}
      tabIndex={0}
    >
      <span class="mx-strip-name" title={name}>{name}</span>
      {!props.compact && <span class="mx-strip-kind">{stripKind(p, name)}</span>}
      <div class="mx-strip-fader"><LevelFader session={session} name={name} orientation="vertical" label={props.compact ? `Live board: ${name} level` : undefined} /></div>
      <DbField value={shownLevel(p, name, session.editing.value)} label={props.compact ? `Live board: ${name} level in dB` : `${name} level in dB`} disabled={session.readOnly} title="Type a level in dB (−60 to +6)" onCommit={(db) => session.commit(setLevel(session.project.peek(), name, db, session.editing.peek()), levelLabel(session.project.peek(), name, session.editing.peek()))} />
      {!props.compact && kind !== "vca" && <span class="mx-strip-line" title={loud ? "Short-term loudness of this bus" : "Loudness shows while the Studio's audio plays (on metered buses)"}>{lufs}</span>}
      {!props.compact && v && <span class={`mx-strip-line${v.own ? "" : " inherited"}`}>Voices {v.text}</span>}
      {kind !== "vca" && <MuteSolo session={session} name={name} solo={kind === "bus"} />}
    </div>
  );
}

function StripsView(props: { session: MixerSession; menu: Menu; setMenu(m: Menu): void }) {
  const { session } = props;
  const p = session.project.value;
  const [moving, setMoving] = useState<string | null>(null);
  const master = masterOf(p);
  const onMenu = (name: string) => (e: MouseEvent) => {
    e.preventDefault();
    session.select(name);
    if (name !== master) props.setMenu({ at: { x: e.clientX, y: e.clientY }, name });
  };
  return (
    <div class="mx-strips" role="group" aria-label="Console">
      {routingRows(p).map((r) => <Strip key={r.name} session={session} name={r.name} onMenu={onMenu(r.name)} />)}
      {p.returns.map((r) => <Strip key={r.name} session={session} name={r.name} onMenu={onMenu(r.name)} />)}
      {props.menu && <ContextMenu entries={menuFor(session, props.menu.name, null, () => setMoving(props.menu!.name))} at={props.menu.at} label={`${props.menu.name} menu`} onClose={() => props.setMenu(null)} />}
      {moving && <MoveBusDialog session={session} name={moving} onClose={() => setMoving(null)} />}
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
      {open && (pins.length === 0 ? <p class="mx-note">No pinned buses: pin one from its menu (right-click).</p> : <div class="mx-board-strips">{pins.map((n) => <Strip key={n} session={session} name={n} compact />)}</div>)}
    </section>
  );
}

export function BusesPanel(props: { session: MixerSession }) {
  const { session } = props;
  const p = session.project.value;
  const { drag, start } = useRerouteDrag(session);
  const [menu, setMenu] = useState<Menu>(null);
  // The row whose name is being typed: F2, a double-click, Rename, or a bus, return or VCA just made (it starts in
  // rename mode with its name selected, as New playlist and New snapshot do).
  const [renaming, setRenaming] = useState<string | null>(null);
  const created = (name: string | null) => {
    if (name === null) return;
    session.view.value = "list";
    // Its parents open, so the row (and its name field) shows.
    const open = new Set(session.collapsed.peek());
    for (let up = busOf(session.project.peek(), name)?.parent ?? null; up; up = busOf(session.project.peek(), up)?.parent ?? null) open.delete(up);
    if (open.size !== session.collapsed.peek().size) session.collapsed.value = open;
    setRenaming(name);
  };
  return (
    <MixFrame session={session} class="mx-buses" label="Buses">
      <div class="mx-buses-inner">
        <Toolbar session={session} drag={drag} onCreated={created} />
        {p.buses.length === 1 && p.returns.length === 0 && <p class="mx-note">Only Master so far: add a bus for each kind of sound.</p>}
        {session.view.value === "list" ? <ListView session={session} drag={drag} startDrag={start} menu={menu} setMenu={setMenu} renaming={renaming} setRenaming={setRenaming} /> : <StripsView session={session} menu={menu} setMenu={setMenu} />}
        {session.view.value === "list" && <LiveBoard session={session} />}
      </div>
    </MixFrame>
  );
}
