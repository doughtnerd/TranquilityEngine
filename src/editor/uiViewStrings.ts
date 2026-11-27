// Svelte UI's text for the Localisation panel (ADR 0356 §7, §8, ADR 0423 wave F): the unkeyed literal text written in
// the project's components (`uiEdit/svelteStrings.ts` over each file's `parse()`), and the fit check's targets: every
// element the open scene's views rendered whose text is one keyed message, with its text's font and its content box
// from the scene view's layout (`textFit.ts` lays each language out in it).
import type { GameObject } from "../engine";
import { UIText, type UIComponentType } from "../engine/ui/components";
import { textRunOf } from "../engine/ui/elementKinds";
import type { UIHostElement } from "../engine/ui/host/UIHost";
import { uiBorderEdges, uiEdges } from "../engine/ui/layout";
import { isSvelteComponentPath } from "../projectCode/uiModules";
import type { FitTarget } from "./ui/localisation/textFit";
import { textKeyOf, unkeyedTextIn, type UnkeyedText } from "./uiEdit/svelteStrings";
import { elementAtLocation } from "./uiEdit/svelteText";
import { sourceOfFile, viewsOn } from "./uiViews";

/** The unkeyed text of every component among `files` that parses (Svelte's parser loaded), dismissed ones (by `unkeyedId`) left out by the caller. */
export function unkeyedTextOf(files: Iterable<string>): UnkeyedText[] {
  const out: UnkeyedText[] = [];
  for (const path of files) {
    if (!isSvelteComponentPath(path)) continue;
    const source = sourceOfFile(path);
    if (source) out.push(...unkeyedTextIn(path, source));
  }
  return out;
}

/** A rendered element's laid-out size in UI pixels (its border box), or null when it isn't laid out: the scene view's. */
export type SizeOf = (c: UIComponentType) => readonly [number, number] | null;

function walk(el: UIHostElement, fn: (el: UIHostElement) => void): void {
  fn(el);
  for (const c of el.children) walk(c, fn);
}

function viewRoots(node: GameObject, out: UIHostElement[]): void {
  for (const v of viewsOn(node)) if (v.root) out.push(v.root);
  for (const c of node.children) viewRoots(c, out);
}

/** The text component an element's text is drawn by: its own, or a button's label (the text the renderer made inside it). */
function textComponentOf(el: UIHostElement): UIText | null {
  if (el.component instanceof UIText) return el.component;
  const label = el.children.find((c) => c.synthetic && c.isValid && c.component instanceof UIText);
  return (label?.component as UIText | undefined) ?? null;
}

/**
 * The fit check's targets under `root` (the open scene's node): each place in a component written as one keyed message
 * and rendered by a view there (once, however often it renders), with its content box where its size is fixed (`width`
 * or `height` not `auto`; `sizeOf` the scene view's layout). `unrendered` counts the keyed elements written in `files`'
 * components that no view rendered (or that aren't laid out).
 */
export function fitTargets(root: GameObject | null, sizeOf: SizeOf, files: Iterable<string>): { targets: FitTarget[]; unrendered: number } {
  const targets: FitTarget[] = [];
  const seen = new Set<string>();
  const roots: UIHostElement[] = [];
  if (root) viewRoots(root, roots);
  for (const r of roots) {
    walk(r, (el) => {
      if (!el.source || el.synthetic || !el.isValid) return;
      const place = `${el.source.file}|${el.source.line}:${el.source.column}`;
      if (seen.has(place)) return;
      const source = sourceOfFile(el.source.file);
      const element = source && elementAtLocation(source, el.source.line, el.source.column);
      const call = element && textKeyOf(source, element);
      const text = call && textComponentOf(el);
      const size = text && sizeOf(el.component);
      if (!call || !text || !size) return;
      seen.add(place);
      const run = textRunOf(text);
      if (!run) return;
      const c = el.component as unknown as { width?: unknown; height?: unknown; padding?: number; paddingTop?: number | null; paddingRight?: number | null; paddingBottom?: number | null; paddingLeft?: number | null };
      const [pt, pr, pb, pl] = uiEdges(c.padding ?? 0, c.paddingTop ?? null, c.paddingRight ?? null, c.paddingBottom ?? null, c.paddingLeft ?? null);
      const [bt, br, bb, bl] = uiBorderEdges(c);
      const fixed = (v: unknown) => v !== undefined && v !== "auto";
      const font = { fontSize: run.fontSize, fontWeight: run.fontWeight, fontFamily: run.fontFamily, lineHeight: run.lineHeight, wrap: run.wrap };
      targets.push({
        path: el.source.file,
        where: el.id ? `#${el.id}` : `<${el.tag}>`,
        line: el.source.line,
        key: call.key,
        run: font,
        box: { width: fixed(c.width) ? Math.max(0, size[0] - pl - pr - bl - br) : null, height: fixed(c.height) ? Math.max(0, size[1] - pt - pb - bt - bb) : null },
      });
    });
  }
  let unrendered = 0;
  for (const path of files) {
    if (!isSvelteComponentPath(path)) continue;
    const source = sourceOfFile(path);
    if (!source) continue;
    for (const el of source.elements) {
      if (!textKeyOf(source, el)) continue;
      const at = source.text.slice(0, el.start);
      const line = at.split("\n").length, column = el.start - at.lastIndexOf("\n") - 1;
      if (!seen.has(`${path}|${line}:${column}`)) unrendered++;
    }
  }
  return { targets, unrendered };
}
