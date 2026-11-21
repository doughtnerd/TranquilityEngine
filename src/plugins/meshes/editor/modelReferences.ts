// The files a model names in its own format (ADR 0148), and rewriting them when files move (ADR 0314), contributed
// through the Meshes plugin's asset kinds as their `references`: an .obj's material libraries, an .mtl's texture
// maps and a .gltf's external buffers and images (ADR 0088). Each format finds its reference tokens in the text
// once; `read` resolves them against the file's folder, `rewrite` splices new relative paths into the same places,
// so the rest of the file (layout, comments, options) is kept byte for byte. A binary .glb or .fbx isn't read.
import type { AssetReferences, ReferenceMoves } from "../../../editor/sdk";
import { isRelativeReference, relativePath, resolveRelative } from "./relativePaths";

/** One reference in a file's text: where it is written, and the relative path it holds (decoded). */
interface Token {
  readonly start: number;
  readonly end: number;
  readonly ref: string;
}

/** A model format's references: where they are, and how a relative path is written in one's place. */
interface ReferenceFormat {
  tokens(text: string): Token[];
  write(ref: string): string;
}

/** An .obj's material libraries (`mtllib`, each file named) and an .mtl's texture maps (`map_Kd`, `bump`…, the file after any options). */
const wavefront: ReferenceFormat = {
  tokens(text) {
    const out: Token[] = [];
    const line = /^[ \t]*(mtllib|map_\w+|bump|disp|norm)[ \t]+([^\r\n]*?)[ \t]*\r?$/gim;
    for (let m = line.exec(text); m; m = line.exec(text)) {
      const argsAt = m.index + m[0].indexOf(m[2], m[1].length);
      const words = [...m[2].matchAll(/\S+/g)];
      // Options (`-bm 1 file.png`) come first in a map statement; the file is the last word. `mtllib` names files only.
      for (const w of m[1].toLowerCase() === "mtllib" ? words : words.slice(-1)) out.push({ start: argsAt + w.index!, end: argsAt + w.index! + w[0].length, ref: w[0] });
    }
    return out;
  },
  write: (ref) => ref,
};

/** A .gltf's `uri`s (buffers, images), URI-encoded in a JSON string; `data:` URIs aren't references. */
const gltf: ReferenceFormat = {
  tokens(text) {
    const out: Token[] = [];
    const uri = /"uri"\s*:\s*("(?:[^"\\]|\\.)*")/g;
    for (let m = uri.exec(text); m; m = uri.exec(text)) {
      let value: string;
      try {
        value = JSON.parse(m[1]) as string;
      } catch {
        continue;
      }
      let ref = value;
      try {
        ref = decodeURIComponent(value);
      } catch {
        // kept as written
      }
      const start = m.index + m[0].length - m[1].length;
      out.push({ start, end: start + m[1].length, ref });
    }
    return out;
  },
  write: (ref) => JSON.stringify(ref.split("/").map(encodeURIComponent).join("/")),
};

const formatOf = (path: string): ReferenceFormat | null => {
  const lower = path.toLowerCase();
  return lower.endsWith(".gltf") ? gltf : lower.endsWith(".obj") || lower.endsWith(".mtl") ? wavefront : null;
};

function read(path: string, text: string): string[] {
  const format = formatOf(path);
  return format ? format.tokens(text).filter((t) => isRelativeReference(t.ref)).map((t) => resolveRelative(path, t.ref)) : [];
}

function rewrite(path: string, text: string, moves: ReferenceMoves): string | null {
  const format = formatOf(path);
  if (!format) return null;
  let out = "";
  let at = 0;
  let changed = false;
  for (const token of format.tokens(text)) {
    if (!isRelativeReference(token.ref)) continue;
    const target = moves.to(resolveRelative(moves.from, token.ref));
    if (resolveRelative(path, token.ref) === target) continue; // still names it from here
    out += text.slice(at, token.start) + format.write(relativePath(path, target));
    at = token.end;
    changed = true;
  }
  return changed ? out + text.slice(at) : null;
}

/** The `model` kind's references: Wavefront for .obj, glTF for .gltf (binary .glb and .fbx aren't read). */
export const modelReferences: AssetReferences = { extensions: [".obj", ".gltf"], read, rewrite };

/** The `mtl` kind's references: an .mtl's texture maps. */
export const materialLibraryReferences: AssetReferences = { read, rewrite };
