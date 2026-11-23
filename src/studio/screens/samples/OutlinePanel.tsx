// The Outline (the prototype's): everything on the open sample in groups (Cues, Exits, Hit points, Loops, Notes,
// Ranges, Snippets), sorted naturally, with a filter; clicking an item selects it, double-clicking also moves the
// playhead there. Items from the file carry a "file" chip.
import { useState } from "preact/hooks";
import { Chip } from "../../../editor/ui/Chip";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { Icon } from "../../components/Icon";
import * as act from "./sampleActions";
import { lengthOf } from "./sampleSession";
import { outlineGroups, selectionKey } from "./sampleView";
import { openSession, select, selection } from "./samplesState";

/** Arrow keys move between an outline list's items; Space selects, Enter also moves the playhead (the double-click). */
function onItemKey(ev: KeyboardEvent, choose: (go: boolean) => void): void {
  const li = ev.currentTarget as HTMLElement;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const items = [...li.closest(".smp-outline")!.querySelectorAll<HTMLElement>('[role="option"]')];
    items[Math.max(0, Math.min(items.length - 1, items.indexOf(li) + (ev.key === "ArrowDown" ? 1 : -1)))]?.focus();
  } else if (ev.key === " " || ev.key === "Enter") {
    ev.preventDefault();
    choose(ev.key === "Enter");
  }
}

export function OutlinePanel() {
  const session = openSession.value;
  const [query, setQuery] = useState("");
  const length = session ? lengthOf(session.project, session.source.value) : null;
  if (!session || length === null) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState compact title="Outline" icon={<Icon name="menu" size={28} />} body="The open sample's cues, exits, hit points, loops, notes, ranges and snippets." />
      </Panel>
    );
  }
  const groups = outlineGroups(session.edits.value, length, query);
  const current = selectionKey(selection.value);
  // One item takes Tab (the selected one, else the first), arrows reach the rest.
  const all = groups.flatMap((g) => g.items.map((i) => selectionKey(i.selection)));
  const tabStop = all.includes(current) ? current : all[0];
  return (
    <Panel class="smp-outline" toolbar={<input type="search" placeholder="Filter" aria-label="Filter the outline" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />}>
      {groups.map((g) => (
        <section key={g.id} class="smp-outline-group" aria-label={g.title}>
          <h4>
            {g.title} <span class="smp-muted">{g.items.length || ""}</span>
          </h4>
          {g.items.length === 0 ? (
            <p class="smp-muted smp-outline-empty">{query ? "No match" : g.empty}</p>
          ) : (
            <ul role="listbox" aria-label={g.title}>
              {g.items.map((i) => (
                <li key={i.key} role="option" aria-selected={selectionKey(i.selection) === current} class={selectionKey(i.selection) === current ? "on" : undefined}
                  tabIndex={selectionKey(i.selection) === tabStop ? 0 : -1} title={`${i.name} · Enter moves the playhead here`}
                  onClick={() => select(i.selection)}
                  onDblClick={() => (select(i.selection), act.movePlayhead(i.at))}
                  onKeyDown={(ev) => onItemKey(ev, (go) => (select(i.selection), go && act.movePlayhead(i.at)))}>
                  <span class="smp-ellipsis">{i.name}</span>
                  {i.fromFile && <Chip tone="success" title="From the WAV file">file</Chip>}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </Panel>
  );
}
