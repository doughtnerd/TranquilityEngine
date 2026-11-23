// The Studio's keymap (ADR 0349 "Keyboard"): one registry of shortcuts in three scopes. Global keys work on every
// screen (Ctrl/⌘+1…6, F6, ?, Undo and Redo); screen keys while their screen shows; panel keys while focus is inside
// an element marked `data-keyscope="<panel>"`. The innermost panel wins, then the screen, then global. Shortcuts
// without a modifier ("single-key shortcuts": Space, M, ?) follow a per-user preference and never fire while typing;
// combos fire while typing only when they say so (screen switching does; Undo doesn't, text fields keep their own).
// The shortcuts dialog lists the registry.
import { formatKeys, isSingleKey, matchesCombo, parseCombo, type KeyCombo, type KeyEventLike } from "../../editor/ui/keyCombo";
import type { ShortcutGroup } from "../../editor/ui/shortcutListModel";
import type { ScreenId } from "./screens";

export type KeyScope = "global" | { readonly screen: ScreenId } | { readonly panel: string };

export interface KeyBinding {
  /** Unique in the keymap. */
  readonly id: string;
  /** Its combos ("Mod+Shift+Z", "Ctrl+Y"); the first is the one menus show. */
  readonly keys: readonly string[];
  /** What it does, as the shortcuts dialog lists it. */
  readonly label: string;
  /** The dialog's group (default: the scope's: "Everywhere", the screen, the panel). */
  readonly group?: string;
  readonly scope: KeyScope;
  /** Also while typing in a text field (only combos with a modifier). */
  readonly inText?: boolean;
  /** Do it. Returning false lets the key through (nothing to do now). */
  run(): boolean | void;
}

/** Where the key was pressed. */
export interface KeyContext {
  /** The screen showing. */
  readonly screen: ScreenId;
  /** The panel scopes focus is inside, innermost first. */
  readonly panels: readonly string[];
  /** The single-key shortcuts preference. */
  readonly singleKeys: boolean;
  /** Focus is in a text field. */
  readonly typing: boolean;
  readonly mac: boolean;
}

export interface Keymap {
  /** Add a binding (replacing one with its id); returns the removal. */
  register(binding: KeyBinding): () => void;
  /** The binding a key press runs, or null. */
  resolve(e: KeyEventLike, ctx: KeyContext): KeyBinding | null;
  /** Run the binding for a key press; true when one ran (the caller then prevents the browser's default). */
  handle(e: KeyEventLike, ctx: KeyContext): boolean;
  /** The shortcuts the dialog lists for `screen`: global ones, the screen's, then each panel's. */
  list(screen: ScreenId, singleKeys: boolean, screenTitle?: (id: ScreenId) => string): ShortcutGroup[];
}

interface Entry {
  readonly binding: KeyBinding;
  readonly combos: readonly KeyCombo[];
}

const scopeRank = (scope: KeyScope, ctx: KeyContext): number => {
  if (scope === "global") return 0;
  if ("screen" in scope) return scope.screen === ctx.screen ? 1 : -1;
  const at = ctx.panels.indexOf(scope.panel);
  return at < 0 ? -1 : 100 - at; // the innermost panel first
};

export function createKeymap(): Keymap {
  const entries = new Map<string, Entry>();
  const allowed = (combo: KeyCombo, b: KeyBinding, ctx: KeyContext) => (isSingleKey(combo) ? ctx.singleKeys && !ctx.typing : !ctx.typing || !!b.inText);
  const keymap: Keymap = {
    register(binding) {
      const combos = binding.keys.map(parseCombo).filter((c): c is KeyCombo => c !== null);
      const entry = { binding, combos };
      entries.set(binding.id, entry);
      return () => {
        if (entries.get(binding.id) === entry) entries.delete(binding.id);
      };
    },
    resolve(e, ctx) {
      let best: { b: KeyBinding; rank: number } | null = null;
      for (const { binding, combos } of entries.values()) {
        const rank = scopeRank(binding.scope, ctx);
        if (rank < 0 || (best && best.rank >= rank)) continue;
        if (combos.some((c) => matchesCombo(c, e, ctx.mac) && allowed(c, binding, ctx))) best = { b: binding, rank };
      }
      return best?.b ?? null;
    },
    handle(e, ctx) {
      const b = keymap.resolve(e, ctx);
      return b ? b.run() !== false : false;
    },
    list(screen, singleKeys, screenTitle = (id) => id) {
      const groups = new Map<string, ShortcutGroup["entries"][number][]>();
      const add = (title: string, b: KeyBinding, combos: readonly KeyCombo[]) => {
        const list = groups.get(title) ?? (groups.set(title, []).get(title) as ShortcutGroup["entries"][number][]);
        list.push({ label: b.label, keys: b.keys, off: !singleKeys && combos.length > 0 && combos.every(isSingleKey) });
      };
      const ordered = [...entries.values()].sort((a, b) => order(a.binding.scope) - order(b.binding.scope));
      for (const { binding, combos } of ordered) {
        const s = binding.scope;
        if (s !== "global" && "screen" in s && s.screen !== screen) continue;
        add(binding.group ?? (s === "global" ? "Everywhere" : "screen" in s ? screenTitle(s.screen) : s.panel), binding, combos);
      }
      return [...groups].map(([title, list]) => ({ title, entries: list }));
    },
  };
  return keymap;
}

const order = (s: KeyScope) => (s === "global" ? 0 : "screen" in s ? 1 : 2);

/** The first combo of a binding as the platform writes it, for a tooltip ("Mixer (Ctrl+3)"). */
export const keysHint = (binding: Pick<KeyBinding, "keys">, mac: boolean): string => (binding.keys[0] ? formatKeys(binding.keys[0], mac) : "");

/** The panel scopes an element is inside (`data-keyscope`), innermost first. */
export function panelScopesOf(el: Element | null): string[] {
  const out: string[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    const scope = n.getAttribute?.("data-keyscope");
    if (scope) out.push(scope);
  }
  return out;
}
