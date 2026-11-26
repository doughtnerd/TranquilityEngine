// The Library panel's view (the prototype's library, spec 4.2.3): the project's samples in collapsible folders (with
// counts, and Collapse all), a search (at most 300 rows), each sample a row with a 72 × 36 waveform thumbnail that
// previews it (an accent playhead sweeps while it plays), its name and length ("16.0 s ∞" for a loop). Rows drag onto
// the open playlist (adding an entry), add on a double-click, or from their menu: Add to the open playlist, Add to
// another playlist (a submenu), Open in Samples, Preview, Create playlist from… Click selects, Ctrl/⌘-click toggles,
// Shift-click selects a range. A view over props.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ContextMenu, SEPARATOR } from "../../../editor/ui/ContextMenu";
import type { PeakMips } from "../../../plugins/audio/editor/music/peaksMip";
import { envelopeRuns, waveColumns } from "../../components/waveformModel";
import { Icon } from "../../components/Icon";
import { secondsText } from "./entryRowModel";
import { COLLAPSE_GLYPH, Glyph } from "./glyphs";
import { createPlaylistLabel, libraryClick, libraryGroups, menuTargets, sampleDragText, type LibrarySelection } from "./libraryModel";
import { playlistTitle } from "./playlistPaths";
import { EmptyState } from "../../../editor/ui/EmptyState";

/** What a thumbnail knows of a sample (null fields until its peaks are read). */
export interface SampleFacts {
  readonly peaks: PeakMips | null;
  /** Its playable length, seconds. */
  readonly length: number | null;
  readonly loops: boolean;
}

export interface LibraryListProps {
  readonly files: readonly string[];
  /** The open playlist's name, for "Add to …" (null: none open, or it can't take samples). */
  readonly addTo: string | null;
  /** The sample previewing now, and when it started (ms, for the playhead). */
  readonly previewing: string | null;
  onPreview(path: string): void;
  onAdd(path: string): void;
  onOpenSamples(sample?: string): void;
  /** Create a playlist of these samples (absent or `writable` false: the menu entry is disabled). */
  onCreatePlaylist?(paths: readonly string[]): void;
  /** Playlists a sample can be added to (files), and adding it to one. */
  readonly playlists?: readonly string[];
  onAddTo?(playlist: string, sample: string): void;
  /** A sample's thumbnail facts (read when its row is on screen). */
  factsOf?(path: string): SampleFacts;
  readonly writable?: boolean;
  /** ADR 0360 §9: what the Library lists above the samples (the generators), given the search. */
  extra?(query: string): ComponentChildren;
}

/** A thumbnail's envelope as an SVG path over 72 × 36, mirrored about the middle. */
function thumbPath(peaks: PeakMips | null, length: number | null): string {
  if (!peaks || !length) return "";
  const end = peaks.rate > 0 ? peaks.frames / peaks.rate : length;
  let d = "";
  for (const run of envelopeRuns(waveColumns(peaks, { start: 0, end }, 72))) {
    const top = run.amps.map((a, i) => `${run.x + i},${(18 - Math.max(0.5, a * 16)).toFixed(1)}`);
    const bottom = run.amps.map((a, i) => `${run.x + i},${(18 + Math.max(0.5, a * 16)).toFixed(1)}`).reverse();
    d += `M${top.join("L")}L${bottom.join("L")}Z`;
  }
  return d;
}

/** True once `ref` has been on screen (a thumbnail reads its sample's peaks only then). */
function useSeen(ref: { current: Element | null }): boolean {
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((list) => list.some((e) => e.isIntersecting) && setSeen(true));
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return seen;
}

function Thumb(props: { readonly path: string; readonly name: string; readonly playing: boolean; readonly facts?: (path: string) => SampleFacts; onPreview(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const seen = useSeen(ref);
  const f = seen && props.facts ? props.facts(props.path) : null;
  return (
    <button ref={ref} type="button" class={`pl-lwv${props.playing ? " on" : ""}`} aria-label={`Preview ${props.name}`} aria-pressed={props.playing} title={props.playing ? "Stop the preview" : "Preview (up to 30 s)"} onClick={props.onPreview}>
      <svg viewBox="0 0 72 36" preserveAspectRatio="none" aria-hidden="true"><path d={thumbPath(f?.peaks ?? null, f?.length ?? null)} /></svg>
      {props.playing && <span class="pl-lph" style={f?.length ? { animationDuration: `${Math.min(30, f.length)}s` } : undefined} />}
      <span class="pl-lpi"><Icon name={props.playing ? "stop" : "play"} size={12} /></span>
    </button>
  );
}

export function LibraryList(props: LibraryListProps) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [sel, setSel] = useState<LibrarySelection>({ selected: [], anchor: null });
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const { groups, total, shown } = libraryGroups(props.files, query);
  const searching = query.trim() !== "";
  const order = groups.flatMap((g) => (searching || !closed.has(g.folder) ? g.samples.map((s) => s.path) : []));
  const none = libraryGroups(props.files).total === 0;
  const toggle = (f: string) => {
    const next = new Set(closed);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    setClosed(next);
  };
  return (
    <div class="pl-library">
      <div class="pl-tree-tools">
        <input type="search" class="pl-search" placeholder={props.extra ? "Search generators and samples" : "Search samples"} aria-label="Search samples" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <button type="button" class="pl-ib" aria-label="Collapse all sample folders" title="Collapse all sample folders" onClick={() => setClosed(new Set(groups.map((g) => g.folder)))}>
          <Glyph paths={COLLAPSE_GLYPH} size={14} />
        </button>
      </div>
      {props.extra && <div class="pl-lib-groups" role="list" aria-label="Generators">{props.extra(query)}</div>}
      {none ? (
        <EmptyState compact title="No samples in this project yet." action={{ label: "Go to Samples", run: () => props.onOpenSamples() }} />
      ) : (
        <div class="pl-lib-groups" role="list" aria-label="Samples">
          {groups.length === 0 && <p class="pl-note">No sample matches “{query.trim()}”.</p>}
          {groups.map((g) => {
            const open = searching || !closed.has(g.folder);
            return (
              <div key={g.folder} class="pl-lib-group" role="group" aria-label={g.folder || "Project folder"}>
                <button type="button" class="pl-lfold" aria-expanded={open} onClick={() => toggle(g.folder)} title={g.folder || "The project's own folder"}>
                  <Icon name={open ? "chevronDown" : "chevronRight"} size={10} />
                  <Icon name="folder" size={13} />
                  <span class="pl-nm">{g.folder ? g.folder.slice(g.folder.lastIndexOf("/") + 1) : "Project folder"}</span>
                  <span class="pl-count">{g.samples.length}</span>
                </button>
                {open && g.samples.map((s) => {
                  const f = props.factsOf?.(s.path);
                  return (
                    <div
                      key={s.path}
                      role="listitem"
                      class={`pl-lib-row${sel.selected.includes(s.path) ? " selected" : ""}`}
                      draggable
                      title={`${s.name} · ${props.addTo ? "double-click or drag onto the playlist to add it · " : ""}right-click or long-press for more`}
                      onDragStart={(e) => {
                        e.dataTransfer?.setData("text/plain", sampleDragText(s.path));
                        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
                      }}
                      onDblClick={() => props.addTo && props.onAdd(s.path)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (!sel.selected.includes(s.path)) setSel({ selected: [s.path], anchor: s.path });
                        setMenu({ path: s.path, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <Thumb path={s.path} name={s.name} playing={props.previewing === s.path} facts={props.factsOf} onPreview={() => props.onPreview(s.path)} />
                      {/* The name is the row's select button (pressed: picked for "Create playlist from"); Enter adds the sample. */}
                      <button
                        type="button"
                        class="pl-lib-pick"
                        aria-pressed={sel.selected.includes(s.path)}
                        aria-keyshortcuts={props.addTo ? "Enter" : undefined}
                        onClick={(e) => setSel(libraryClick(sel, order, s.path, { toggle: e.ctrlKey || e.metaKey || e.detail === 0, range: e.shiftKey }))}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" || !props.addTo) return;
                          e.preventDefault();
                          props.onAdd(s.path);
                        }}
                      >
                        <span class="pl-lsn">
                          <span class="pl-lib-name">{s.name}</span>
                          {/* A search result names its folder on the meta line, not before the name (J6.2: "GameSFX/HoverBike/Brak…"). */}
                          <span class="pl-u pl-lib-meta">{[searching && g.folder ? g.folder : "", `${f?.length ? secondsText(f.length).replace(/(\.\d)\d s$/, "$1 s") : s.derived ? "sample" : ""}${f?.loops ? " ∞" : ""}`].filter(Boolean).join(" · ")}</span>
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {searching && shown < total && <p class="pl-note">Showing {shown} of {total}; type more to narrow it.</p>}
        </div>
      )}
      {menu && (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          label="Sample menu"
          onClose={() => setMenu(null)}
          entries={[
            { kind: "group", label: menuTargets(sel, menu.path).length > 1 ? `${menuTargets(sel, menu.path).length} samples` : menu.path.slice(menu.path.lastIndexOf("/") + 1) },
            { id: "add", label: props.addTo ? `Add to “${props.addTo}”` : "Add to the open playlist", hint: "Double-click", disabled: !props.addTo, title: props.addTo ? undefined : "Open a playlist that takes entries (a Clip takes one sample; a Sequence takes them on its timeline)", run: () => props.onAdd(menu.path) },
            {
              id: "addTo", label: "Add to playlist", disabled: !props.onAddTo || props.writable === false || !(props.playlists ?? []).length, run: () => {},
              submenu: (props.playlists ?? []).map((p) => ({ id: p, label: playlistTitle(p), note: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : undefined, run: () => props.onAddTo?.(p, menu.path) })),
            },
            SEPARATOR,
            { id: "preview", label: props.previewing === menu.path ? "Stop the preview" : "Preview", run: () => props.onPreview(menu.path) },
            { id: "samples", label: "Open in Samples", run: () => props.onOpenSamples(menu.path) },
            SEPARATOR,
            {
              id: "createPlaylist", label: createPlaylistLabel(menuTargets(sel, menu.path)),
              disabled: !props.onCreatePlaylist || props.writable === false,
              run: () => props.onCreatePlaylist?.(menuTargets(sel, menu.path)),
            },
          ]}
        />
      )}
    </div>
  );
}
