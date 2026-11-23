// The Library's generators (ADR 0360 §9): the project's `*.generator.json` with their kind badge, searched with the
// Library's search, above the samples; click opens one in the Generator editor, double-click or the menu adds it to
// the open playlist (a Clip plays it; a sequence gets a generator clip), and rows drag like samples. "New generator"
// makes a file of a kind, or an embedded generator in the open playlist. A view over props.
import { useState } from "preact/hooks";
import { ContextMenu, type MenuEntry } from "../../../../editor/ui/ContextMenu";
import type { GeneratorKind } from "../../../../engine/audio/generators/types";
import { generatorDragText, type GeneratorRow } from "./generatorEntries";
import { KIND_CHOICES } from "./generatorKinds";
import { GeneratorBadge, GeneratorIcon } from "./GeneratorParts";
import "./generator.css";

export interface GeneratorLibraryProps {
  readonly rows: readonly GeneratorRow[];
  /** The open generator's path (highlighted). */
  readonly open: string | null;
  /** The open playlist's name for "Add to …", or null (none open). */
  readonly addTo: string | null;
  readonly writable: boolean;
  /** A search is on (an empty list then says nothing matched). */
  readonly searching: boolean;
  onOpen(path: string): void;
  onAdd(path: string): void;
  onNew(kind: GeneratorKind): void;
  /** New embedded generator in the open playlist (absent: none open). */
  onNewEmbedded?(kind: GeneratorKind): void;
}

export function GeneratorLibrary(props: GeneratorLibraryProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; path: string | null } | null>(null);
  const newEntries: MenuEntry[] = [
    ...KIND_CHOICES.map((k) => ({ id: `new-${k.kind}`, label: `New ${k.label.toLowerCase()} generator`, disabled: !props.writable, run: () => props.onNew(k.kind) })),
    ...(props.onNewEmbedded && props.addTo
      ? [{ kind: "separator" as const }, ...KIND_CHOICES.map((k) => ({ id: `embed-${k.kind}`, label: `New ${k.label.toLowerCase()} in “${props.addTo}”`, disabled: !props.writable, run: () => props.onNewEmbedded!(k.kind) }))]
      : []),
  ];
  const rowEntries = (path: string): MenuEntry[] => [
    { id: "open", label: "Open", run: () => props.onOpen(path) },
    { id: "add", label: props.addTo ? `Add to “${props.addTo}”` : "Add to the open playlist", disabled: !props.addTo || !props.writable, run: () => props.onAdd(path) },
  ];
  return (
    <div class="pl-lib-group" role="group" aria-label="Generators">
      <div class="pl-lib-folder gen-lib-row">
        <span>Generators</span>
        <button
          type="button"
          class="pl-icon gen-new"
          aria-label="New generator"
          title="New generator"
          disabled={!props.writable}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom, path: null });
          }}
        >
          +
        </button>
      </div>
      {props.rows.length === 0 && (
        <p class="pl-note">
          {props.searching ? "No generator matches." : (
            <>
              <GeneratorIcon /> No generators yet: + makes an oscillator, synth, blip or silence.
            </>
          )}
        </p>
      )}
      {props.rows.map((g) => (
        <div
          key={g.path}
          role="listitem"
          class={`pl-lib-row${props.open === g.path ? " selected" : ""}`}
          aria-current={props.open === g.path ? "true" : undefined}
          draggable
          title={`${g.path}${props.addTo ? ` · double-click to add it to ${props.addTo}` : ""}`}
          onClick={() => props.onOpen(g.path)}
          onDblClick={() => props.addTo && props.writable && props.onAdd(g.path)}
          onDragStart={(e) => {
            e.dataTransfer?.setData("text/plain", generatorDragText(g.path));
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, path: g.path });
          }}
        >
          <GeneratorBadge kind={g.kind} />
          <span class="pl-lib-name">{g.name}</span>
          {g.preset && <span class="pl-row-meta">{g.preset}</span>}
        </div>
      ))}
      {menu && <ContextMenu at={{ x: menu.x, y: menu.y }} label={menu.path ? "Generator menu" : "New generator"} onClose={() => setMenu(null)} entries={menu.path ? rowEntries(menu.path) : newEntries} />}
    </div>
  );
}
