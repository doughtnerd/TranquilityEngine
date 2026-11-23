// The editor and the Studio are written against Preact's core, where `onChange` on an input is the DOM's `change` event (a
// commit) and `onInput` each step of a drag or a keystroke. `preact/compat` installs a global options hook the moment any
// module loads it, and from then on every `onChange` on an input or textarea anywhere on the page is wired to `input`: a
// colour pick, a number field or a slider commits on every step (one undo step each). The UI pass's `FloatingPortal` loaded
// it for `createPortal` (Preact 11 has that in core), which broke the particle colour, tileset and parameter fields.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const SRC = join(__dirname, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

it("no shipped module imports preact/compat (it rewires every input's onChange to input events)", () => {
  const importers = sources(SRC)
    .filter((f) => /from\s+["']preact\/compat["']|import\(\s*["']preact\/compat["']\s*\)/.test(readFileSync(f, "utf8")))
    .map((f) => relative(SRC, f).replaceAll("\\", "/"));
  expect(importers).toEqual([]);
});
