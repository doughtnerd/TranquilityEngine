/**
 * Rewrite the reference strings in a JSON file's text for a set of moves, keeping everything else byte for byte
 * (layout, key order, escapes of untouched strings). A reference string is the editor's (ADR 0148, `assetRefValues.ts`):
 * a project path with an optional `asset:` prefix and leading `./` or `/`, optionally followed by `#slice`; the prefix
 * and slice are kept and only the path changes. Object keys are never rewritten. The migration uses it for every JSON
 * file of a project that isn't open in an editor (the editor's own moves go through each file's owner, ADR 0302).
 *
 * Pure; no plugin, no DOM.
 */
import { assetRefPrefix } from "../../scene/assetPath";

/** `ref` with its path moved by `moves` (old project path → new), or null when it names no moved path. */
export function movedReference(ref: string, moves: ReadonlyMap<string, string>): string | null {
  const prefix = assetRefPrefix(ref);
  const rest = ref.slice(prefix.length);
  const hash = rest.indexOf("#");
  const path = hash < 0 ? rest : rest.slice(0, hash);
  const to = moves.get(path);
  return to === undefined ? null : prefix + to + (hash < 0 ? "" : rest.slice(hash));
}

/**
 * `text` with every JSON string value naming a moved path rewritten, or null when nothing changes (or `text` isn't
 * JSON). Strings are found by scanning, so a file's formatting survives.
 */
export function rewriteJsonReferences(text: string, moves: ReadonlyMap<string, string>): string | null {
  if (moves.size === 0) return null;
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  let out = "";
  let last = 0;
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    let end = i + 1;
    while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
    const literal = text.slice(i, end + 1);
    let k = end + 1;
    while (k < text.length && /\s/.test(text[k])) k++;
    const isKey = text[k] === ":";
    if (!isKey) {
      const to = movedReference(JSON.parse(literal) as string, moves);
      if (to !== null) {
        out += text.slice(last, i) + JSON.stringify(to);
        last = end + 1;
        changed = true;
      }
    }
    i = end;
  }
  return changed ? out + text.slice(last) : null;
}
