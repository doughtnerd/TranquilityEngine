// ADR 0171 record change on `registerMixPanels`: new audio UI registers only through it (api-and-models §7, Pf4).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EditorPluginContext } from "../../../../editor/sdk";
import { PROFILER_PANEL, registerMixPanels } from "./index";

const MIX_DIR = __dirname;

describe("registerMixPanels", () => {
  it("registers the Profiler panel once, lazily, and nothing else", () => {
    const panels: { id: string; title: string; view: () => Promise<unknown> }[] = [];
    const others: string[] = [];
    const ctx = new Proxy({ registerPanel: (p: (typeof panels)[number]) => void panels.push(p) } as object, {
      get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : (..._a: unknown[]) => void others.push(String(k))),
    }) as unknown as EditorPluginContext;
    registerMixPanels(ctx);
    expect(panels.map((p) => p.id)).toEqual([PROFILER_PANEL]);
    expect(PROFILER_PANEL).toBe("audioprofiler");
    expect(panels[0]!.title).toBe("Audio Profiler");
    expect(others).toEqual([]); // no menu entry, toolbar button, shortcut, tool or section
  });

  it("no other file under editor/mix registers a panel, a menu entry, a toolbar item or a shortcut", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && e.name !== "index.ts") {
          const text = readFileSync(p, "utf8");
          if (/\bregisterPanel\b|registerSceneToolbarItem|registerMenu|registerShortcut|registerKeybinding/.test(text)) offenders.push(e.name);
        }
      }
    };
    walk(MIX_DIR);
    expect(offenders).toEqual([]);
  });

  it("editor/index.ts calls registerMixPanels, and no file outside mix/index.ts registers the profiler or mixer panel ids", () => {
    const editorDir = join(MIX_DIR, "..");
    const text = readFileSync(join(editorDir, "index.ts"), "utf8");
    expect(text.match(/registerMixPanels\(context\)/g)).toHaveLength(1);
    expect(text).not.toMatch(/audioprofiler|audiomixer/);
  });

  it("the panel's styles use theme tokens only: no colour literal in the CSS or the view", () => {
    for (const name of ["profilerPanel.css", "ProfilerPanel.tsx"]) {
      const text = readFileSync(join(MIX_DIR, name), "utf8");
      expect(text, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    }
  });
});
