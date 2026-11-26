// The Outline (spec §4.1.4, the prototype's): everything on the open sample in groups (Cues, Entries, Exits, Hit points,
// Loops with the pickup, links and tail, Notes, Snippets, Trim), each row with its colour swatch (round for a point,
// square for a range), a loop's Active icon, ⚠ when it's outside the trim, a "file" chip when it came from the WAV and
// its time or range at the right. The filter ("Filter 7 items") hides groups with no match and counts "2 of 3"; group
// headers fold with a caret, and Collapse all folds every group. Clicking a row selects it, Enter or a double-click
// also moves the playhead there; right-click (or Shift+F10) opens its menu.
import { useState } from "preact/hooks";
import { Chip } from "../../../editor/ui/Chip";
import { ContextMenu, SEPARATOR, tidyEntries, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { Icon } from "../../components/Icon";
import { formatTime, type TimeContext } from "../../components/timeRulerModel";
import * as act from "./sampleActions";
import { deleteMarker, removeLoop, tapeSnippet, toggleSnippet, viewTime } from "./sampleEditing";
import { SampleIcon, type SampleIconName } from "./sampleIcons";
import { lengthOf } from "./sampleSession";
import { outlineGroups, selectionKey, snippetMenu, type OutlineItem } from "./sampleView";
import { dialog, openSession, select, selection, timeFormat } from "./samplesState";

const ACTIVE_ICON: Record<NonNullable<OutlineItem["active"]>, SampleIconName> = { always: "endless", held: "held", parameter: "parameter" };

/** Arrow keys move between the outline's rows; Space selects, Enter also moves the playhead (the double-click). */
function onItemKey(ev: KeyboardEvent, choose: (go: boolean) => void, menu: (at: { x: number; y: number }) => void): void {
  const li = ev.currentTarget as HTMLElement;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Home" || ev.key === "End") {
    ev.preventDefault();
    const items = [...li.closest(".smp-outline")!.querySelectorAll<HTMLElement>('[role="option"]')];
    const i = items.indexOf(li);
    const to = ev.key === "Home" ? 0 : ev.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)));
    items[to]?.focus();
  } else if (ev.key === " " || ev.key === "Enter") {
    ev.preventDefault();
    choose(ev.key === "Enter");
  } else if ((ev.key === "F10" && ev.shiftKey) || ev.key === "ContextMenu") {
    ev.preventDefault();
    const r = li.getBoundingClientRect();
    menu({ x: r.left + 16, y: r.bottom });
  }
}

export function OutlinePanel() {
  const session = openSession.value;
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[]; label: string } | null>(null);
  const length = session ? lengthOf(session.project, session.source.value) : null;
  if (!session || length === null) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState compact title="No sample open" icon={<Icon name="menu" size={28} />} body="Its markers, loops and snippets list here." />
      </Panel>
    );
  }
  const e = session.edits.value;
  const ro = session.readOnly;
  const ctx: TimeContext = { rate: 48000, bpm: e.tempo?.bpm, meter: e.tempo?.meter };
  const fmt = timeFormat.value;
  const t = (s: number) => formatTime(viewTime(e, s), fmt, ctx);
  const all = outlineGroups(e, length);
  const groups = outlineGroups(e, length, query);
  const count = all.reduce((n, g) => n + g.total, 0);
  const filtering = query.trim() !== "";
  const shown = filtering ? groups.filter((g) => g.items.length > 0) : groups;
  const current = selectionKey(selection.value);
  // One item takes Tab (the selected one, else the first), arrows reach the rest.
  const keys = shown.flatMap((g) => (closed.has(g.id) && !filtering ? [] : g.items.map((i) => selectionKey(i.selection))));
  const tabStop = keys.includes(current) ? current : keys[0];

  const itemMenu = (i: OutlineItem, at: { x: number; y: number }) => {
    select(i.selection);
    const s = i.selection;
    let entries: MenuEntry[];
    if (s.kind === "snippet") {
      const run = {
        save: () => (dialog.value = { kind: "snippet", index: s.index }),
        tapeLeft: () => session.commit(tapeSnippet(e, s.index, "left", length)),
        tapeRight: () => session.commit(tapeSnippet(e, s.index, "right", length)),
        toggle: () => session.commit(toggleSnippet(e, s.index, length)),
        closeGap: () => act.closeSnippetGap(s.index),
      };
      const items = snippetMenu(e, length, s.index).map((m) => ({ id: m.id, label: m.label, disabled: ro || m.refused !== null, title: m.refused ?? undefined, danger: m.danger, run: run[m.id] }));
      entries = tidyEntries([{ kind: "group", label: `${i.name} · ${t(i.at)} – ${t(i.end ?? i.at)}` }, items[0], SEPARATOR, items[1], items[2], SEPARATOR, items[3], items[4]]);
    } else {
      entries = tidyEntries([
        { kind: "group", label: i.name },
        { id: "play", label: "Play", run: () => act.togglePlay(s) },
        { id: "go", label: "Move the playhead here", hint: "Enter", run: () => act.movePlayhead(i.at) },
        { id: "zoom", label: "Zoom to it", hint: "Z", run: () => act.zoomToSelection() },
        (s.kind === "marker" || s.kind === "loop") && SEPARATOR,
        s.kind === "marker" && { id: "delete", label: "Delete", hint: "Del", danger: true, disabled: ro, run: () => (session.commit(deleteMarker(e, s.id)), select({ kind: "sample" })) },
        s.kind === "loop" && { id: "remove", label: "Remove loop", hint: "Del", danger: true, disabled: ro, run: () => (session.commit(removeLoop(e, s.id)), select({ kind: "sample" })) },
      ]);
    }
    setMenu({ ...at, entries, label: `${i.name} menu` });
  };

  const toolbar = (
    <div class="smp-outline-bar">
      <input type="search" placeholder={`Filter ${count} item${count === 1 ? "" : "s"}`} aria-label="Filter the outline" title="Filter markers, loops and snippets by name (Esc clears)" value={query}
        onInput={(ev) => setQuery((ev.currentTarget as HTMLInputElement).value)}
        onKeyDown={(ev) => ev.key === "Escape" && query && (ev.preventDefault(), ev.stopPropagation(), setQuery(""))} />
      <button type="button" class="smp-ibtn" aria-label="Collapse all groups" title={closed.size >= groups.length ? "Expand all groups" : "Collapse all groups"}
        onClick={() => setClosed(closed.size >= groups.length ? new Set() : new Set(groups.map((g) => g.id)))}>
        <SampleIcon name="collapseAll" size={14} />
      </button>
    </div>
  );
  return (
    <Panel class="smp-outline" toolbar={toolbar}>
      {shown.length === 0 && <p class="smp-muted smp-pad" role="status">Nothing's name holds “{query.trim()}”.</p>}
      {shown.map((g) => {
        const open = filtering || !closed.has(g.id);
        return (
          <section key={g.id} class="smp-outline-group" aria-label={g.title}>
            <h4>
              <button type="button" class="smp-ogh" aria-expanded={open} onClick={() => setClosed((c) => (c.has(g.id) ? new Set([...c].filter((x) => x !== g.id)) : new Set([...c, g.id])))}>
                <span class="smp-car" aria-hidden="true">{open ? "▾" : "▸"}</span>
                <span class="smp-ogh-title">{g.title}</span>
                <span class="smp-ogh-count">{filtering ? `${g.items.length} of ${g.total}` : g.total}</span>
              </button>
            </h4>
            {open && g.items.length === 0 && g.empty && <EmptyState compact title={g.empty} />}
            {open && g.items.length > 0 && (
              <ul role="listbox" aria-label={g.title}>
                {g.items.map((i) => {
                  const k = selectionKey(i.selection);
                  const on = k === current;
                  return (
                    <li key={i.key} role="option" aria-selected={on} class={`${on ? "on" : ""}${i.deleted ? " gone" : ""}`.trim() || undefined}
                      tabIndex={k === tabStop ? 0 : -1} title={`${i.name}${i.outside ? " · outside the trim · won't play" : ""} · Enter moves the playhead here · right-click for more`}
                      onClick={() => select(i.selection)}
                      onDblClick={() => (select(i.selection), act.movePlayhead(i.at))}
                      onContextMenu={(ev) => (ev.preventDefault(), itemMenu(i, { x: ev.clientX, y: ev.clientY }))}
                      onKeyDown={(ev) => onItemKey(ev, (go) => (select(i.selection), go && act.movePlayhead(i.at)), (at) => itemMenu(i, at))}>
                      <span class={`smp-osw${i.end !== undefined ? " range" : ""}`} style={{ background: i.color }} aria-hidden="true" />
                      {i.active && <SampleIcon name={ACTIVE_ICON[i.active]} size={11} />}
                      <span class="smp-ellipsis smp-oname">{i.name}</span>
                      {i.outside && <span class="smp-warning" title="Outside the trim · won't play">⚠</span>}
                      {i.fromFile && <Chip tone="success" title="From the WAV file">file</Chip>}
                      <span class="smp-otime">{i.end !== undefined ? `${t(i.at)} – ${t(i.end)}` : t(i.at)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      {menu && <ContextMenu entries={menu.entries} at={{ x: menu.x, y: menu.y }} label={menu.label} onClose={() => setMenu(null)} />}
    </Panel>
  );
}
