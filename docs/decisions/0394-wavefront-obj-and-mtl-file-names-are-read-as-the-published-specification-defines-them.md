# 0394. Wavefront .obj and .mtl file names are read as the published specification defines them, by the loader and the reference reader alike

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0314)
- **Related:** 0044, 0088, 0148, 0314

## Context

Two pieces of code read the file names in Wavefront text, and they disagreed:

- The **model loader** (`src/engine/scene/models.ts`) took the whole rest of the *first* `mtllib` line as one library
  name, so `mtllib a.mtl b.mtl` looked for a file called `a.mtl b.mtl`, and later `mtllib` lines were ignored. It
  handed the `.mtl` to three.js's MTLLoader, which takes the rest of a map line, after `-bm`, `-mm` and a
  three-number `-s`/`-o`, as the texture name: `map_Kd -clamp on tex.png` asked for a texture called
  `-clamp on tex.png`, and `-s 2 tex.png` (one number) swallowed the file name.
- The **reference reader** (`src/plugins/meshes/editor/modelReferences.ts`, ADR 0314) read every word of every
  `mtllib` and took a map statement's *last word* as its file. A word after the file name was rewritten in its place
  when files moved.

The owner's decision (review item Q3): follow the published specification. That is Wavefront's *Advanced Visualizer*
manual, Appendix B, "Object Files (.obj)" (B1) and "Material Library File (.mtl)" (B2), as mirrored by Paul Bourke
(paulbourke.net/dataformats/obj/ and /mtl/). What it says, for the statements that name files:

- **Statements** (B1, "File structure"): a keyword followed by arguments separated by white space; a line ending in a
  backslash continues on the next line; a line starting with `#` is a comment.
- **`mtllib filename1 filename2 . . .`** (B1, "Display/render attributes"): names the material library files for
  `usemtl`. "You can specify multiple filenames with mtllib. If multiple filenames are specified, the first file
  listed is searched first for the material definition, the second file is searched next, and so on."
- **Texture maps** (B2, "Texture map statements"): `map_Ka -options args filename`, and likewise `map_Kd`, `map_Ks`,
  `map_Ns`, `map_d`, `decal`, `disp`, `bump` and `refl -type <type> -options args filename`. One file name, after the
  options. The options and their arguments: `-blendu on|off`, `-blendv on|off`, `-cc on|off`, `-clamp on|off`,
  `-imfchan r|g|b|m|l|z`, `-texres value`, `-boost value`, `-bm mult` (bump), `-type` (refl), `-mm base gain`, and
  `-o u v w`, `-s u v w`, `-t u v w`, where "v ... is optional" and "w ... is optional" (one to three numbers; `-s`
  defaults to 1, `-o` and `-t` to 0). `map_aat on|off` turns texture antialiasing on and names no file.
- **White space in file names.** The specification has no quoting or escaping: arguments are separated by white
  space, so a file name is one word and can't contain a space. Nothing on a map statement follows the file name.

ADR 0314 said "a map statement's last word after its options"; that is right for a file that follows the
specification, but takes the wrong word when anything follows the file name.

The network host serving the mirrors wasn't reachable from the session that made this change, so the text above was
written from the specification as known, not re-fetched; check it against the mirror when convenient.

## Decision

We will read Wavefront file names exactly as the specification defines them, in **one pure module both readers use**,
`src/engine/scene/wavefront.ts` (no three.js, not public API):

- `wavefrontStatements(text)`: statements with word positions, continuation lines joined, comment lines skipped.
- `materialLibraryFiles(text)`: every argument of every `mtllib` statement, in order.
- `readTextureMap(args)`: a map statement's options, each taking the specification's arguments (one word for the
  on/off, channel and value options; one to three numbers for `-o`, `-s`, `-t`; one or two for `-mm`), always leaving
  a word for the file; then the **file name, the word after the options**, and `extra` (whatever follows it).
  `isTextureMapStatement` names the statements that take a file: the specification's, plus the common `map_*` and
  `norm` extensions, never `map_aat`.

The **loader** loads every library every `mtllib` names (a missing one warns and the materials only it defines draw
with the default), the first named winning a name defined twice. Each `.mtl` is rewritten before three.js reads it:
every map statement becomes the options three.js understands (`-s`, `-o` padded to three numbers with the
specification's defaults; `-bm` on bump maps, `-mm` on `disp`) followed by the one file name; words after the file
name are dropped with a warning. The library preview (`.mtl` swatches) reads the same rewrite.

The **reference reader** reports and rewrites, when files move, every `mtllib` file and each map's file name (the word
after the options). Options, their arguments, words after the file name, comments, spacing and line endings stay byte
for byte.

This amends ADR 0314's Wavefront rule ("a map statement's last word after its options") to "the word after the
options, as the specification counts their arguments".

## Alternatives considered

- **The rest of the line is one path** (the loader's old reading, Q3 option a) — lets a name contain spaces, which some
  exporters write, but the specification doesn't allow it and it contradicts `mtllib`'s several files. Not chosen: the
  owner chose the specification.
- **The last word is the file** (ADR 0314 as written) — agrees with the specification only when nothing follows the
  file name, and needs no option table. Not chosen: a trailing word was rewritten as if it were the file.
- **Keep two readers** — the loader with its own regular expression, the editor with another. Not chosen: they drifted
  apart once already; one module keeps them agreeing.

## Consequences

**Positive**
- The loader, the reference list and the rewrite on move name the same files, for `mtllib` with several files,
  several `mtllib` lines, continued lines and maps with any of the specification's options.
- Textures with options three.js doesn't understand (`-clamp`, `-imfchan`, `-cc`, `-texres`, `-blendu`…) now load.

**Negative / costs**
- A non-standard file with spaces in a texture or library name no longer loads that file (it never did for `mtllib`
  with more than the name; for maps it used to work by accident). The loader warns.
- The loader rewrites `.mtl` text before three.js parses it; a three.js upgrade that reads more options needs the
  rewrite to pass them on.

## Deprecates

The loader's single-`mtllib` regular expression and the reference reader's last-word rule (both removed).

## Open questions

- Material libraries in another folder than the `.obj`: their textures are still looked up from the model's folder
  first (with the existing fallbacks), as before.

## References

- Wavefront Technologies, *Advanced Visualizer* manual, Appendix B1 "Object Files (.obj)", B2 "Material Library File
  (.mtl)"; mirrors at paulbourke.net/dataformats/obj/ and paulbourke.net/dataformats/mtl/.
- ADR 0314; review item Q3.
