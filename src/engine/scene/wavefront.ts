/**
 * The file names in Wavefront `.obj` and `.mtl` text, read as the published format specifications define them
 * (Wavefront Advanced Visualizer, Appendix B "Object Files (.obj)" and "Material Library File (.mtl)"; ADR 0394).
 * Pure, with positions in the text, so the model loader (which files to load) and the editor's reference reader
 * (which files a model uses, rewritten in place when they move) read the same names.
 *
 * - A statement is a keyword and its arguments, separated by whitespace (spaces or tabs). A line ending in `\`
 *   continues on the next line. A line whose first non-blank character is `#` is a comment.
 * - `mtllib filename1 filename2 ...` names one or more material libraries, each one argument; several `mtllib`
 *   statements may appear, and every file they name is a library (the first named is searched first).
 * - A texture map statement (`map_Ka`, `map_Kd`, `map_Ks`, `map_Ns`, `map_d`, `decal`, `disp`, `bump`, `refl`, and the
 *   common `map_*`/`norm` extensions) is `keyword -options args filename`: its options, each with the arguments the
 *   specification gives it, then exactly one file name. `map_aat on|off` names no file.
 *
 * The specifications have no quoting or escaping, so a file name can't contain whitespace: what follows the file name
 * on a map statement isn't part of it (`extra`).
 */

/** One whitespace-separated word of the text, and where it is (`end` exclusive). */
export interface WavefrontToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** One statement: its keyword (as written) and arguments, continuation lines joined. */
export interface WavefrontStatement {
  readonly keyword: WavefrontToken;
  readonly args: readonly WavefrontToken[];
}

/** A texture map option and its arguments. */
export interface WavefrontMapOption {
  readonly name: string;
  readonly args: readonly WavefrontToken[];
}

/** A texture map statement read: its options, its file name (null if none is given), and any words after the file. */
export interface WavefrontMap {
  readonly options: readonly WavefrontMapOption[];
  readonly file: WavefrontToken | null;
  readonly extra: readonly WavefrontToken[];
}

/** Every statement in `text`, comments and blank lines left out. */
export function wavefrontStatements(text: string): WavefrontStatement[] {
  const out: WavefrontStatement[] = [];
  let words: WavefrontToken[] = [];
  const word = /[^ \t\r\n]+/g;
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const continued = /\\[ \t]*$/.test(line);
    if (continued) line = line.replace(/\\[ \t]*$/, "");
    const lineWords: WavefrontToken[] = [];
    word.lastIndex = 0;
    for (let m = word.exec(line); m; m = word.exec(line)) lineWords.push({ text: m[0], start: lineStart + m.index, end: lineStart + m.index + m[0].length });
    if (words.length || !lineWords[0]?.text.startsWith("#")) words.push(...lineWords);
    if (!continued) {
      if (words.length) out.push({ keyword: words[0]!, args: words.slice(1) });
      words = [];
    }
    lineStart = lineEnd + 1;
  }
  if (words.length) out.push({ keyword: words[0]!, args: words.slice(1) });
  return out;
}

/** The material libraries an `.obj` names: every argument of every `mtllib` statement, in order. */
export function materialLibraryFiles(text: string): WavefrontToken[] {
  return wavefrontStatements(text).flatMap((s) => (s.keyword.text.toLowerCase() === "mtllib" ? s.args : []));
}

/** True for the `.mtl` statements whose last argument is a texture file. */
export function isTextureMapStatement(keyword: string): boolean {
  const k = keyword.toLowerCase();
  return k === "bump" || k === "disp" || k === "decal" || k === "refl" || k === "norm" || (k.startsWith("map_") && k !== "map_aat");
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * How many arguments each option takes: [fewest, most]. Options with a range take numbers: `-o`/`-s`/`-t u [v [w]]`
 * (the specification marks v and w optional) and `-mm base gain` (both given by the specification; a file that leaves
 * out gain still reads its file name). The rest take one word (`on`/`off`, a channel, a value, a `refl -type`).
 */
const OPTION_ARGS: Readonly<Record<string, readonly [number, number]>> = {
  "-blendu": [1, 1],
  "-blendv": [1, 1],
  "-bm": [1, 1],
  "-boost": [1, 1],
  "-cc": [1, 1],
  "-clamp": [1, 1],
  "-imfchan": [1, 1],
  "-texres": [1, 1],
  "-type": [1, 1],
  "-mm": [1, 2],
  "-o": [1, 3],
  "-s": [1, 3],
  "-t": [1, 3],
};

/** A texture map statement's arguments read as options, then the file name. */
export function readTextureMap(args: readonly WavefrontToken[]): WavefrontMap {
  const options: WavefrontMapOption[] = [];
  let i = 0;
  while (i < args.length - 1) {
    const name = args[i]!.text.toLowerCase();
    const counts = OPTION_ARGS[name];
    if (!counts) break; // not an option the specifications define: the file name
    const [fewest, most] = counts;
    let n = 0;
    // Take arguments up to the option's most, numbers where it takes a range, leaving one word for the file name.
    while (n < most && i + 1 + n < args.length - 1 && (fewest === most || NUMBER.test(args[i + 1 + n]!.text))) n++;
    if (n < fewest) break;
    options.push({ name, args: args.slice(i + 1, i + 1 + n) });
    i += 1 + n;
  }
  return { options, file: args[i] ?? null, extra: args.slice(i + 1) };
}

/** Every texture file an `.mtl` names: each map statement's file name. */
export function textureMapFiles(text: string): WavefrontToken[] {
  const out: WavefrontToken[] = [];
  for (const s of wavefrontStatements(text)) {
    if (!isTextureMapStatement(s.keyword.text)) continue;
    const file = readTextureMap(s.args).file;
    if (file) out.push(file);
  }
  return out;
}
