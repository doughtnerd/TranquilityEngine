// Find in a graph panel (ADR 0117, in the graph layer since ADR 0259): Ctrl+F (through
// `useGraphSelection`'s `openFind`) or a toolbar button opens a box over the canvas that lists the
// matches of `findInGraph`; Enter or Arrow Down goes to the next, Shift+Enter or Arrow Up to the
// previous (wrapping), a click picks one, Escape closes. Going to a match selects it (a group selects
// its members) and frames it; a note is framed by its rectangle.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GraphDocument, GraphPropertyData } from "./document";
import { cycleIndex, findInGraph, type FindItem, type GraphMatch } from "./graphFind";
import { NO_PAN, NO_WHEEL, type CanvasNode } from "./xyflow";
import type { ClipboardPayload } from "../clipboard";

export interface GraphFindOptions<G, P extends GraphPropertyData, C extends ClipboardPayload> {
  /** The panel's graph document (its notes and groups). */
  edits: GraphDocument<G, P, C>;
  /** The graph as drawn now. */
  graph: G;
  /** The graph's canvas items as find reads them (the panel's titles and searchable fields). */
  items(graph: G): readonly FindItem[];
  /** Select these items (`useGraphSelection`'s `setSelection`). */
  setSelection(ids: Set<string>): void;
  /** Fit these nodes in the view (`useGraphCanvas`'s `frameAll`). */
  frameAll(nodes: readonly CanvasNode[]): void;
  /** The canvas nodes now. */
  nodes(): readonly CanvasNode[];
  /** The panel's focusable root, which gets the keyboard back when find closes. */
  root: { readonly current: HTMLElement | null };
  /** Find opened: close the panel's popups. */
  onOpen?(): void;
  /** A match was gone to: clear the panel's other selections (a wire, a block). */
  onGo?(match: GraphMatch): void;
}

/** The find box's state and actions; draw it with `GraphFindBox`. */
export function useGraphFind<G, P extends GraphPropertyData, C extends ClipboardPayload>(o: GraphFindOptions<G, P, C>) {
  /** The query and the result shown, and how many times find was opened (the box selects its text each time). */
  const [state, setState] = useState<{ query: string; index: number; opened: number } | null>(null);
  const opened = useRef(0);
  const matches = useMemo(() => (state ? findInGraph(o.items(o.graph), o.edits.notes(o.graph), o.edits.groups(o.graph), state.query) : []), [o.graph, state?.query]);

  const go = (index: number) => {
    const m = matches[index];
    if (!m) return;
    setState((f) => f && { ...f, index });
    o.onGo?.(m);
    if (m.kind === "note") {
      const note = o.edits.notes(o.graph).find((n) => n.id === m.id);
      if (!note) return;
      o.setSelection(new Set());
      o.frameAll([{ id: note.id, x: note.position[0], y: note.position[1], width: note.size[0], height: note.size[1], selected: false, inputs: [], outputs: [] }]);
      return;
    }
    const ids = new Set(m.frame);
    o.setSelection(ids);
    o.frameAll(o.nodes().filter((n) => ids.has(n.id)));
  };
  const open = () => {
    o.onOpen?.();
    opened.current++;
    setState((f) => ({ query: f?.query ?? "", index: f?.index ?? -1, opened: opened.current }));
  };
  const close = () => {
    setState(null);
    o.root.current?.focus({ preventScroll: true });
  };
  return {
    /** Whether the box is open. */
    isOpen: state !== null,
    state,
    matches,
    open,
    close,
    toggle: () => (state ? close() : open()),
    go,
    setQuery: (query: string) => setState((f) => f && { ...f, query, index: -1 }),
  };
}

/** The find box over the canvas (nothing while find is closed). */
export function GraphFindBox(props: { find: ReturnType<typeof useGraphFind>; placeholder: string }) {
  const { find } = props;
  const input = useRef<HTMLInputElement>(null);
  const opened = find.state?.opened;
  useEffect(() => {
    if (opened) input.current?.select();
  }, [opened]);
  const state = find.state;
  if (!state) return null;
  const { matches } = find;
  return (
    <div class={`sg-find ${NO_PAN} ${NO_WHEEL}`} role="search" aria-label="Find in graph">
      <div class="sg-find-row">
        <input
          ref={input}
          type="text"
          placeholder={props.placeholder}
          aria-label="Find in graph"
          value={state.query}
          onInput={(e) => find.setQuery((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            const k = e.key;
            if (k === "Escape") find.close();
            else if (k === "Enter" || k === "ArrowDown" || k === "ArrowUp") {
              const step = k === "ArrowUp" || (k === "Enter" && e.shiftKey) ? -1 : 1;
              find.go(cycleIndex(state.index, matches.length, step));
            } else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <span class="sg-find-count" aria-live="polite">
          {state.query.trim() ? (matches.length ? `${state.index >= 0 ? state.index + 1 : "–"} of ${matches.length}` : "No matches") : ""}
        </span>
        <button title="Close (Escape)" aria-label="Close find" onClick={find.close}>
          ✕
        </button>
      </div>
      {matches.length > 0 && (
        <ul>
          {matches.map((m, i) => (
            <li key={`${m.kind}-${m.id}`} class={i === state.index ? "active" : ""} onClick={() => find.go(i)}>
              <span class="sg-find-label">{m.label}</span>
              <span class="sg-find-kind">{m.kind === "node" ? m.field : m.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
