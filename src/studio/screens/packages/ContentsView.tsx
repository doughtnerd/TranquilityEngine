// The Packages screen's Contents tab (ADR 0337 §6): the selected package's include entries (each removable) and what it
// holds once its dependencies are added — per asset why it is in (an entry, or the asset that needs it), its profile,
// codec, load mode, shipped size and memory for the chosen platform, and an "also in" warning for a sound in several
// packages (its bytes are duplicated in each). Below, the assets in no package. Add a sound by dragging it onto the table
// or a package, or from its menu; remove one from its menu (refused, with why, when a glob or another asset holds it).
// A view over props.
import { useState } from "preact/hooks";
import { Chip } from "../../../editor/ui/Chip";
import { ContextMenu, SEPARATOR, tidyEntries, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import type { LoadMode } from "../../../engine/audio/encoding/types";
import type { PackCodec } from "../../../engine/audio/packaging/format";
import { figureText } from "../../encoding/estimate";
import type { PackageView } from "./packagesModel";
import { SOUND_DRAG_TYPE } from "./PackageListView";

/** What the table shows of one sound's conversion for the platform (null: not an audio file, or not known yet). */
export interface SoundFigures {
  readonly profile: string | null;
  readonly codec: PackCodec;
  readonly load: LoadMode;
  readonly bytes: number | null;
  readonly memoryBytes: number | null;
  readonly exact: boolean;
}

export interface ContentsViewProps {
  readonly view: PackageView | null;
  readonly loose: readonly string[];
  /** Every package's name (the loose rows' "Add to" menu). */
  readonly packages: readonly string[];
  figures(path: string): SoundFigures | null;
  /** Why `path` can't be removed from the selected package, or null. */
  removeRefusal(path: string): string | null;
  readonly readOnly?: boolean;
  onAdd(pkg: string, path: string): void;
  onRemove(pkg: string, path: string): void;
  onRemoveInclude(pkg: string, include: string): void;
  onOpen(path: string): void;
}

const KIND_LABEL = { sample: "Sample", playlist: "Playlist", derived: "Derived sample", other: "File" } as const;
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function Figures({ f }: { f: SoundFigures | null }) {
  if (!f) return <><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></>;
  return (
    <>
      <td>{f.profile ?? "built-in"}</td>
      <td>{f.codec}</td>
      <td>{f.load}</td>
      <td>{f.bytes === null ? "…" : figureText(f.bytes, f.exact)}</td>
      <td>{f.memoryBytes === null ? "…" : figureText(f.memoryBytes, f.exact)}</td>
    </>
  );
}

export function ContentsView(props: ContentsViewProps) {
  const [menu, setMenu] = useState<{ entries: MenuEntry[]; at: Element | { x: number; y: number }; label: string } | null>(null);
  const [over, setOver] = useState(false);
  const v = props.view;
  const ro = props.readOnly === true;
  const rowMenu = (path: string): MenuEntry[] => {
    const why = v ? props.removeRefusal(path) : null;
    return tidyEntries([
      v && { id: "remove", label: `Remove from ${v.def.name}`, disabled: ro || why !== null, title: why ?? undefined, run: () => props.onRemove(v.def.name, path) },
      SEPARATOR,
      { id: "open", label: "Open", run: () => props.onOpen(path) },
    ]);
  };
  const looseMenu = (path: string): MenuEntry[] =>
    tidyEntries([
      ...props.packages.map((name): MenuEntry => ({ id: `add:${name}`, label: `Add to ${name}`, disabled: ro, run: () => props.onAdd(name, path) })),
      props.packages.length > 0 && SEPARATOR,
      { id: "open", label: "Open", run: () => props.onOpen(path) },
    ]);
  const open = (e: MouseEvent, entries: MenuEntry[], label: string, at?: Element) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ entries, at: at ?? { x: e.clientX, y: e.clientY }, label });
  };
  return (
    <div class="pk-contents">
      {!v ? (
        <EmptyState compact title="No package selected" body="Choose a package on the left, or make one, to see what it holds." />
      ) : (
        <section aria-label={`${v.def.name} contents`}>
          <div class="pk-includes" aria-label="Include entries" role="list">
            {v.def.include.length === 0 && <span class="smp-muted">Nothing listed yet: drag sounds or playlists here.</span>}
            {v.def.include.map((inc) => (
              <span key={inc} role="listitem" class={`pk-include${v.unmatched.includes(inc) ? " unmatched" : ""}`} title={v.unmatched.includes(inc) ? "Matches no file" : undefined}>
                {inc}
                <button class="pk-x" aria-label={`Remove entry ${inc}`} disabled={ro} onClick={() => props.onRemoveInclude(v.def.name, inc)}>×</button>
              </span>
            ))}
          </div>
          {v.missing.map((m) => <p key={m.path} class="pk-warning">{m.from} names {m.path}, which isn't in the project.</p>)}
          <div
            class={`pk-table-wrap${over ? " drop" : ""}`}
            onDragOver={(e) => {
              if (ro || !e.dataTransfer?.types.includes(SOUND_DRAG_TYPE)) return;
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              setOver(false);
              const path = e.dataTransfer?.getData(SOUND_DRAG_TYPE);
              if (!path) return;
              e.preventDefault();
              props.onAdd(v.def.name, path);
            }}
          >
            <table class="pk-table" aria-label={`What ${v.def.name} holds`}>
              <thead>
                <tr><th scope="col">Asset</th><th scope="col">In because</th><th scope="col">Profile</th><th scope="col">Codec</th><th scope="col">Load</th><th scope="col">Size</th><th scope="col">Memory</th><th scope="col" aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {v.rows.length === 0 && <tr><td colSpan={8} class="smp-muted">Empty: drop a sound or a playlist here.</td></tr>}
                {v.rows.map((r) => (
                  <tr key={r.path} data-path={r.path} onContextMenu={(e) => open(e, rowMenu(r.path), `${base(r.path)} menu`)}>
                    <th scope="row" title={r.path}>
                      <span class="pk-kind">{KIND_LABEL[r.kind]}</span> {base(r.path)}
                      {r.alsoIn.length > 0 && <> <Chip tone="warning" title="Its bytes are duplicated in each package file">also in {r.alsoIn.join(", ")}</Chip></>}
                    </th>
                    <td class="smp-muted">{r.include !== null ? (r.include === r.path ? "listed" : r.include) : `needed by ${base(r.via ?? "")}`}</td>
                    <Figures f={props.figures(r.path)} />
                    <td><button class="pk-more" aria-label={`${base(r.path)} menu`} onClick={(e) => open(e, rowMenu(r.path), `${base(r.path)} menu`, e.currentTarget as Element)}>⋯</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section class="pk-loose" aria-label="In no package">
        <h4 class="smp-insp-section">In no package · ships loose</h4>
        {props.loose.length === 0 ? (
          <p class="smp-muted">Every sound and playlist is in a package.</p>
        ) : (
          <ul class="pk-loose-rows">
            {props.loose.map((p) => (
              <li key={p} draggable={!ro} title={p}
                onDragStart={(e) => {
                  e.dataTransfer?.setData(SOUND_DRAG_TYPE, p);
                  e.dataTransfer?.setData("text/plain", p);
                }}
                onContextMenu={(e) => open(e, looseMenu(p), `${base(p)} menu`)}>
                <span>{p}</span>
                {v && <button class="smp-link" disabled={ro} onClick={() => props.onAdd(v.def.name, p)}>Add to {v.def.name}</button>}
                <button class="pk-more" aria-label={`${base(p)} menu`} onClick={(e) => open(e, looseMenu(p), `${base(p)} menu`, e.currentTarget as Element)}>⋯</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {menu && <ContextMenu entries={menu.entries} at={menu.at} label={menu.label} onClose={() => setMenu(null)} />}
    </div>
  );
}
