/**
 * Where a UI document's elements are written (ADR 0298): the authoring interface of a built
 * `UIDocument` for tools that edit its files (the editor's UI document edits, hierarchy, handles).
 *
 * The document builds the tree, so it is the one that knows which file and which `<Use>` tag each
 * element came from. This module answers, for a built element: its static path in the tree, where its
 * own tag is written, where its `<Use>` tag is written (a used document's root), what is written
 * there (attributes, text content, spans), and the path a child at a given position will have. The path
 * rule (`""` for the root, then `/#id`, or `/Tag[n]` counted among same-tag siblings, and `/label` for
 * a button's text content) is written once, here; `UIDocument` builds with it.
 *
 * Not part of the game API (`myco` doesn't export it): games query elements by selector.
 */
import { normalizeAssetPath } from "../scene/Assets";
import type { MarkupAttribute, MarkupElement, SourceSpan } from "./document/types";
import type { UIDocument, UIDocumentElement } from "./UIDocument";

/** A tag in a file: the file and its path among element children from the file's root (`[]` for the root). */
export interface MarkupPlace {
  readonly file: string;
  readonly path: readonly number[];
}

/** What a built element's source is, and where it is written. */
export interface UIElementSource {
  /** Its static path in the tree: `""` for the root, `/#menu/Button[1]`, `/#play/label`. */
  readonly path: string;
  /** A button's label made from the button's text content: it has no tag of its own (its text, spans and place are the button's). */
  readonly label: boolean;
  /** The file its tag is written in (the used file for elements from a `<Use>`). */
  readonly file: string;
  /** The used file when it is the root of a `<Use src>`, else null. */
  readonly from: string | null;
  /** Where its own tag is written (a used document's root is that file's root, path `[]`). */
  readonly place: MarkupPlace;
  /** For a used document's root: where its `<Use>` tag is written, in the parent's file. Null otherwise. */
  readonly usePlace: MarkupPlace | null;
  /** Where it sits among its siblings: the `<Use>` tag for a used root, else its own tag. Null for the document's root and for a label. */
  readonly sitePlace: MarkupPlace | null;
  /** Its position among its parent's written children (the `<Use>` tag's for a used root); -1 for the root and for a label. */
  readonly index: number;
  /** How many element children are written inside it (its label and list rows aren't). */
  readonly childCount: number;
  /** The attributes written on its tag (not the `<Use>` tag's). */
  readonly attributes: readonly MarkupAttribute[];
  /** Its text content as written (whitespace collapsed), or null. */
  readonly text: string | null;
  /** Its whole element, and its open tag, in `file`. */
  readonly span: SourceSpan;
  readonly openTagSpan: SourceSpan;
}

/** The path segment of a child: `/#id`, or `/Tag[n]` with `n` the same-tag children written before it. */
function segment(before: readonly MarkupElement[], tag: string, id: string | null): string {
  if (id) return `/#${id}`;
  let n = 0;
  for (const s of before) if (s.tag === tag) n++;
  return `/${tag}[${n}]`;
}

const idOf = (m: MarkupElement): string | null => m.attributes.find((a) => a.name === "id")?.value || null;

/** @internal The UI document's build: the path of each child of `parentPath` written in `children`, in order. */
export function childPaths(parentPath: string, children: readonly MarkupElement[]): string[] {
  return children.map((c, i) => `${parentPath}${segment(children.slice(0, i), c.tag, idOf(c))}`);
}

/** @internal The UI document's build: the path of a button's label made from its text content. */
export const labelPath = (buttonPath: string): string => `${buttonPath}/label`;

/**
 * The path a child of `parent` will have once written at position `at` among its written children, with
 * tag `tag` and id `id`; `moving` (one of those children) is left out first, for a move. `at` is
 * clamped to the children there are.
 */
export function childPath(parent: UIDocumentElement, at: number, tag: string, id: string | null, moving?: UIDocumentElement): string {
  const parentPath = parent._path ?? "";
  const children = parent._markup.children.filter((m) => !moving || m !== moving._markup);
  return `${parentPath}${segment(children.slice(0, Math.max(0, at)), tag, id || null)}`;
}

/** Its position among its parent's written children, or -1 (the root, a label). */
function indexOf(el: UIDocumentElement): number {
  return el.parent ? el.parent._markup.children.indexOf(el._markup) : -1;
}

function ownPlace(el: UIDocumentElement): MarkupPlace {
  if (el._synthetic && el.parent) return ownPlace(el.parent);
  const file = el._markup.file;
  const path: number[] = [];
  for (let e = el; e.parent && !e._markup.from && e.parent._markup.file === file; e = e.parent) path.unshift(indexOf(e));
  return { file, path };
}

function usePlaceOf(el: UIDocumentElement): MarkupPlace | null {
  if (!el._markup.from || !el.parent) return null;
  const parent = ownPlace(el.parent);
  return { file: parent.file, path: [...parent.path, indexOf(el)] };
}

/** An element's source, or null for an element a script made (a list row, or inside one) or one that's gone. */
export function elementSource(el: UIDocumentElement): UIElementSource | null {
  if (el._path === null || !el._alive) return null;
  const m = el._synthetic && el.parent ? el.parent._markup : el._markup;
  const place = ownPlace(el);
  const usePlace = el._synthetic ? null : usePlaceOf(el);
  return {
    path: el._path,
    label: el._synthetic,
    file: m.file,
    from: el._synthetic ? null : (m.from ?? null),
    place,
    usePlace,
    sitePlace: !el.parent || el._synthetic ? null : (usePlace ?? place),
    index: el._synthetic ? -1 : indexOf(el),
    childCount: el._synthetic ? 0 : m.children.length,
    attributes: el._synthetic ? [] : m.attributes,
    text: m.text,
    span: m.span,
    openTagSpan: m.openTagSpan,
  };
}

/** The document's element at a static path (see `UIElementSource.path`), or null. */
export function elementAtPath(doc: UIDocument, path: string): UIDocumentElement | null {
  const visit = (el: UIDocumentElement): UIDocumentElement | null => {
    if (!el._alive || el._path === null) return null;
    if (el._path === path) return el;
    for (const c of el._children) {
      const found = visit(c);
      if (found) return found;
    }
    return null;
  };
  return doc.root ? visit(doc.root) : null;
}

/** The markup file the document's tree was built from (project path), or null before a build. */
export function documentFile(doc: UIDocument): string | null {
  const from = doc._builtFrom;
  return from === null ? null : normalizeAssetPath(from) || null;
}
