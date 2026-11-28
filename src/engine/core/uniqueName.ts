// A name not yet taken: `base`, else `base` with the first free number. One module for the editor's
// settings lists (layers, buses, agent types, Worlds…), pasted nodes, markup ids, the lobby's Worlds,
// imported meshes and every other free name or id the editor and its plugins make (ADR 0465), which
// differ only in how the number is written. Free file paths build on it in src/editor/freePath.ts.

/** How a number is put on a name. */
export interface Numbering {
  /** The numbered name: `stem` with `n` on it. */
  readonly format: (stem: string, n: number) => string;
  /** The first number tried. */
  readonly first: number;
  /** A number this numbering already put on the end of a name, removed before numbering again (`Node (1)` → `Node (2)`, not `Node (1) (1)`). */
  readonly suffix?: RegExp;
}

/** `Layer`, `Layer 2`, `Layer 3`…: settings lists, Worlds, parameters, ports. */
export const SPACED: Numbering = { format: (stem, n) => `${stem} ${n}`, first: 2 };

/** `title`, `title-2`, `title-3`…, renumbering `title-2` rather than extending it: markup ids. */
export const DASHED: Numbering = { format: (stem, n) => `${stem}-${n}`, first: 2, suffix: /-\d+$/ };

/** `enemy`, `enemy-2`, `enemy-3`…, extending `enemy-2` to `enemy-2-2` (unlike DASHED): prefab files, imported tile node ids. */
export const HYPHENATED: Numbering = { format: (stem, n) => `${stem}-${n}`, first: 2 };

/** `action`, `action2`, `action3`…: action names, action set ids. */
export const JOINED: Numbering = { format: (stem, n) => `${stem}${n}`, first: 2 };

/** `run`, `run_2`, `run_3`…: flipbooks, sprite slices, string keys. */
export const UNDERSCORED: Numbering = { format: (stem, n) => `${stem}_${n}`, first: 2 };

/** `Node`, `Node (1)`, `Node (2)`…, renumbering `Node (1)` rather than extending it: scene nodes, as Unity names copies. */
export const BRACKETED: Numbering = { format: (stem, n) => `${stem} (${n})`, first: 1, suffix: / \(\d+\)$/ };

/**
 * `base` if `taken` doesn't have it, else the first numbered name it doesn't have. `taken` is the
 * names in use, or a test for whether a name is (a lookup that isn't a list, such as live Worlds).
 */
export function uniqueName(base: string, taken: Iterable<string> | ((name: string) => boolean), numbering: Numbering = SPACED): string {
  const isTaken = typeof taken === "function" ? taken : setOf(taken);
  if (!isTaken(base)) return base;
  const stem = numbering.suffix ? base.replace(numbering.suffix, "") : base;
  for (let n = numbering.first; ; n++) {
    const name = numbering.format(stem, n);
    if (!isTaken(name)) return name;
  }
}

function setOf(names: Iterable<string>): (name: string) => boolean {
  const set = names instanceof Set ? (names as ReadonlySet<string>) : new Set(names);
  return (name) => set.has(name);
}
