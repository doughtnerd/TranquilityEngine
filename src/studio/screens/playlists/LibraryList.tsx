// The Library panel's view (the prototype's library): the project's samples by folder, a search (at most 300 rows), a
// preview button each through the Studio's runtime, and rows that drag onto the open playlist (adding an entry) or add from
// their menu. Click selects, Ctrl/⌘-click toggles, Shift-click selects a range; the menu's "Create playlist from…" makes
// a new playlist of the selected samples (a Clip for one, a Queue for several). A view over props.
import { useState } from "preact/hooks";
import { ContextMenu } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Icon } from "../../components/Icon";
import { TypeBadge } from "../../components/TypeBadge";
import { createPlaylistLabel, libraryClick, libraryGroups, menuTargets, sampleDragText, type LibrarySelection } from "./libraryModel";

export interface LibraryListProps {
  readonly files: readonly string[];
  /** The open playlist's name, for "Add to …" (null: none open, or it can't take samples). */
  readonly addTo: string | null;
  /** The sample previewing now. */
  readonly previewing: string | null;
  onPreview(path: string): void;
  onAdd(path: string): void;
  onOpenSamples(): void;
  /** Create a playlist of these samples (absent or `writable` false: the menu entry is disabled). */
  onCreatePlaylist?(paths: readonly string[]): void;
  readonly writable?: boolean;
}

export function LibraryList(props: LibraryListProps) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [sel, setSel] = useState<LibrarySelection>({ selected: [], anchor: null });
  const { groups, total, shown } = libraryGroups(props.files, query);
  const order = groups.flatMap((g) => g.samples.map((s) => s.path));
  const none = libraryGroups(props.files).total === 0;
  return (
    <div class="pl-library">
      <div class="pl-tree-tools">
        <input type="search" class="pl-search" placeholder="Search samples" aria-label="Search samples" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
      </div>
      {none ? (
        <EmptyState compact title="No samples yet" body="Samples are the project's audio files and the samples made from them." action={{ label: "Import some in Samples", run: props.onOpenSamples }} />
      ) : (
        <div class="pl-lib-groups" role="list" aria-label="Samples">
          {groups.length === 0 && <p class="pl-note">No sample matches “{query.trim()}”.</p>}
          {groups.map((g) => (
            <div key={g.folder} class="pl-lib-group" role="group" aria-label={g.folder || "Project folder"}>
              <div class="pl-lib-folder">{g.folder || "Project folder"}</div>
              {g.samples.map((s) => (
                <div
                  key={s.path}
                  role="listitem"
                  class={`pl-lib-row${sel.selected.includes(s.path) ? " selected" : ""}`}
                  draggable
                  title={`${s.path}${props.addTo ? ` · drag onto the playlist, or double-click, to add it to ${props.addTo}` : ""}`}
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
                  <button type="button" class={`pl-play${props.previewing === s.path ? " on" : ""}`} aria-label={`Preview ${s.name}`} title="Preview (up to 30 s)" onClick={() => props.onPreview(s.path)}>
                    <Icon name={props.previewing === s.path ? "stop" : "play"} size={10} />
                  </button>
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
                    <TypeBadge sample />
                    <span class="pl-lib-name">{s.name}</span>
                  </button>
                  {s.derived && <span class="pl-row-meta">sample</span>}
                </div>
              ))}
            </div>
          ))}
          {query.trim() && shown < total && <p class="pl-note">Showing {shown} of {total}; type more to narrow it.</p>}
        </div>
      )}
      {menu && (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          label="Sample menu"
          onClose={() => setMenu(null)}
          entries={[
            { id: "add", label: props.addTo ? `Add to “${props.addTo}”` : "Add to the open playlist", disabled: !props.addTo, run: () => props.onAdd(menu.path) },
            { id: "preview", label: "Preview", run: () => props.onPreview(menu.path) },
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
