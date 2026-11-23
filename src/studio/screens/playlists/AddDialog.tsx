// The Add dialog (the prototype's, PL:1365–1402): search, a filter (All / Samples / Playlists / Sequences, with
// counts), several picked at once (Ctrl/⌘ or the checkboxes; a Clip picks one sample), "Link existing" or "Copy" for
// playlists, items that would make a cycle listed but disabled with why. Double-click adds one at once; Enter adds the
// picked ones (arrow keys move through the list, Space picks); Escape closes. A view over the list model (`addDialogModel.ts`).
import { useEffect, useRef, useState } from "preact/hooks";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { TypeBadge } from "../../components/TypeBadge";
import { filterCounts, filterItems, togglePick, type AddFilter, type AddItem } from "./addDialogModel";

export interface AddDialogProps {
  readonly items: readonly AddItem[];
  /** "Add to dirt", "Choose sample…", "Replace sample…". */
  readonly title: string;
  /** A Clip: one sample. */
  readonly single: boolean;
  onAdd(paths: readonly string[], mode: "link" | "copy"): void;
  onClose(): void;
}

export function AddDialog(props: AddDialogProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AddFilter>(props.single ? "samples" : "all");
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [mode, setMode] = useState<"link" | "copy">("link");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => search.current?.focus(), []);
  const shown = filterItems(props.items, query, filter);
  const at = Math.min(active, Math.max(0, shown.length - 1));
  useEffect(() => list.current?.querySelector(".pl-add-row.active")?.scrollIntoView?.({ block: "nearest" }), [at]);
  /** The list from the keyboard: arrows, Home and End move the active row, Space picks it (Enter adds the picked ones). */
  const listKeys = (e: KeyboardEvent) => {
    const last = shown.length - 1;
    const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to !== null) {
      e.preventDefault();
      setActive(Math.max(0, Math.min(last, to)));
    } else if (e.key === " " && shown[at]) {
      e.preventDefault();
      setPicked(togglePick(picked, shown[at]!, true, props.single));
    }
  };
  const counts = filterCounts(props.items, query);
  const add = (paths: readonly string[]) => paths.length && props.onAdd(paths, mode);
  const anyPlaylist = picked.some((p) => props.items.find((i) => i.path === p)?.kind !== "sample");
  return (
    <div class="pl-dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="pl-dialog pl-add" role="dialog" aria-modal="true" aria-label={props.title}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
          else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") add(picked);
        }}>
        <h2 class="pl-dialog-title">{props.title}</h2>
        <input ref={search} type="search" class="pl-search" placeholder="Search samples and playlists" aria-label="Search" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        {!props.single && (
          <SegmentedControl<AddFilter> size="small" label="Show" value={filter} onChange={setFilter}
            options={[
              { value: "all", label: `All ${counts.all}` },
              { value: "samples", label: `Samples ${counts.samples}` },
              { value: "playlists", label: `Playlists ${counts.playlists}` },
              { value: "sequences", label: `Sequences ${counts.sequences}` },
            ]} />
        )}
        <div ref={list} class="pl-add-list" role="listbox" aria-multiselectable={!props.single} aria-label="Samples and playlists" tabIndex={0}
          aria-activedescendant={shown[at] ? `pl-add-opt-${at}` : undefined} onKeyDown={listKeys}>
          {shown.length === 0 && <p class="pl-note">Nothing matches.</p>}
          {shown.map((i, n) => (
            <div key={i.path} id={`pl-add-opt-${n}`} role="option" aria-selected={picked.includes(i.path)} aria-disabled={!!i.disabled} title={i.disabled ?? i.path}
              class={`pl-add-row${picked.includes(i.path) ? " selected" : ""}${i.disabled ? " disabled" : ""}${n === at ? " active" : ""}`}
              onClick={(e) => { setActive(n); setPicked(togglePick(picked, i, e.ctrlKey || e.metaKey, props.single)); }}
              onDblClick={() => !i.disabled && add([i.path])}>
              {!props.single && <input type="checkbox" tabIndex={-1} aria-hidden="true" checked={picked.includes(i.path)} disabled={!!i.disabled} onClick={(e) => { e.stopPropagation(); setPicked(togglePick(picked, i, true, false)); }} />}
              {i.kind === "sample" ? <TypeBadge sample /> : <TypeBadge code={i.badge} />}
              <span class="pl-add-name">{i.name}</span>
              <span class="pl-row-meta">{i.disabled ?? i.folder}</span>
            </div>
          ))}
        </div>
        <div class="pl-dialog-foot">
          {!props.single && (
            <SegmentedControl<"link" | "copy"> size="small" label="Add playlists as" value={mode} onChange={setMode}
              options={[{ value: "link", label: "Link existing", title: "Edits to the playlist change it everywhere it is linked" }, { value: "copy", label: "Copy", title: "An embedded copy of its own" }]} />
          )}
          <span class="pl-faint">{picked.length ? `${picked.length} picked${anyPlaylist && mode === "copy" ? " · copied" : ""}` : "Pick one or more"}</span>
          <button type="button" onClick={props.onClose}>Cancel</button>
          <button type="button" class="pl-primary" disabled={picked.length === 0} onClick={() => add(picked)}>{props.single ? "Choose" : "Add"}</button>
        </div>
      </div>
    </div>
  );
}
