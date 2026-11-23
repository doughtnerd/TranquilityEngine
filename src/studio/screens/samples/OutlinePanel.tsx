// The Outline (the prototype's): everything on the open sample in groups (Cues, Exits, Hit points, Loops, Notes,
// Ranges, Snippets), sorted naturally, with a filter; clicking an item selects it, double-clicking also moves the
// playhead there. Items from the file carry a "file" chip.
import { useState } from "preact/hooks";
import { Chip } from "../../../editor/ui/Chip";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import * as act from "./sampleActions";
import { lengthOf } from "./sampleSession";
import { outlineGroups, selectionKey } from "./sampleView";
import { openSession, select, selection } from "./samplesState";

export function OutlinePanel() {
  const session = openSession.value;
  const [query, setQuery] = useState("");
  const length = session ? lengthOf(session.project, session.source.value) : null;
  if (!session || length === null) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState compact title="Outline" body="The open sample's cues, exits, hit points, loops, notes, ranges and snippets." />
      </Panel>
    );
  }
  const groups = outlineGroups(session.edits.value, length, query);
  const current = selectionKey(selection.value);
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
                <li key={i.key} role="option" aria-selected={selectionKey(i.selection) === current} class={selectionKey(i.selection) === current ? "on" : undefined} tabIndex={-1}
                  onClick={() => select(i.selection)}
                  onDblClick={() => (select(i.selection), act.movePlayhead(i.at))}>
                  <span>{i.name}</span>
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
