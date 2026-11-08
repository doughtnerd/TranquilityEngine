// Import direction (ADR 0133): the editor half may import the runtime half, never the reverse; the
// engine knows nothing of plugins' editor halves or the editor.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");

function files(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [p] : [];
  });
}

/** Module specifiers a file imports or re-exports (static, dynamic, `import type` included unless `skipTypes`). */
function specifiers(file: string): { spec: string; typeOnly: boolean }[] {
  const text = readFileSync(file, "utf8");
  const out: { spec: string; typeOnly: boolean }[] = [];
  const re = /(?:^|[\s;])(?:(import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s+)?|import\s*\(\s*)["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) out.push({ spec: m[3]!, typeOnly: !!m[2] });
  return out;
}

const resolved = (file: string, spec: string) => (spec.startsWith(".") ? resolve(dirname(file), spec) : spec);
const rel = (p: string) => relative(SRC, p).replaceAll("\\", "/");

const editorSide = (target: string): boolean =>
  /^editor(\/|$)/.test(target) || /^plugins\/editor(\.ts)?$/.test(target) || /^plugins\/[^/]+\/editor(\/|$)/.test(target);

describe("plugin import direction", () => {
  const runtimeFiles = [...files(join(SRC, "plugins")).filter((f) => /^plugins\/[^/]+\/runtime\//.test(rel(f))), join(SRC, "plugins/runtime.ts")];

  it("keeps runtime halves free of editor imports", () => {
    const bad: string[] = [];
    for (const f of runtimeFiles) {
      for (const { spec, typeOnly } of specifiers(f)) {
        const target = resolved(f, spec);
        const r = target.startsWith("/") ? rel(target) : target;
        // The manifest type lives in the editor SDK (a type-only import erases at build).
        if (typeOnly && r === "editor/sdk/plugins") continue;
        if (editorSide(r) || /(^|\/)editor(\/|$)/.test(spec)) bad.push(`${rel(f)} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps the engine free of plugin editor halves and the editor", () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, "engine"))) {
      if (/\.test\.tsx?$/.test(f)) continue;
      for (const { spec } of specifiers(f)) {
        const target = resolved(f, spec);
        const r = target.startsWith("/") ? rel(target) : target;
        if (editorSide(r)) bad.push(`${rel(f)} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
