// Spike: activate every first-party editor half under a reduced context, as the Studio would, without the
// scene editor booted. Two experiments:
//   A. a recording fake context (every point a recorded no-op): which points does each half call?
//   B. the real editor activator (`activatePlugin`), the path the Studio takes today for the audio half.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EDITOR_PLUGINS } from "../../src/plugins/editor";
import { activatePlugin, deactivatePlugin, isPluginActive, type EditorPluginContext } from "../../src/editor/sdk/plugins";
import { assetKinds, panels } from "../../src/editor/sdk/contributions";

const report: Record<string, { calls: Record<string, number>; error?: string }> = {};

function recordingContext(name: string, active: ReadonlySet<string>): EditorPluginContext {
  const calls: Record<string, number> = (report[name] = { calls: {} }).calls;
  const ctx = {
    plugins: { isActive: (n: string) => active.has(n) },
  } as Record<string, unknown>;
  return new Proxy(ctx, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (typeof k === "string" && k.startsWith("register")) return () => void (calls[k] = (calls[k] ?? 0) + 1);
      return undefined;
    },
  }) as unknown as EditorPluginContext;
}

describe("A: recording no-op context", () => {
  const allNames = new Set(EDITOR_PLUGINS.map((p) => p.manifest.name));
  for (const p of EDITOR_PLUGINS) {
    it(`${p.manifest.name} activates`, () => {
      try {
        p.activate(recordingContext(p.manifest.name, allNames));
      } catch (e) {
        report[p.manifest.name]!.error = String((e as Error).message ?? e);
        throw e;
      }
    });
  }
  it("prints the table", () => {
    const rows = EDITOR_PLUGINS.map((p) => `${p.manifest.name}\t${report[p.manifest.name]?.error ? "THROWS: " + report[p.manifest.name]!.error : "ok"}\t${Object.entries(report[p.manifest.name]?.calls ?? {}).map(([k, n]) => `${k.replace("register", "")}x${n}`).join(" ")}`);
    writeFileSync("spikes/studio-editor-halves/results-A.txt", rows.join("\n") + "\n");
    expect(EDITOR_PLUGINS.length).toBeGreaterThan(0);
  });
});

describe("B: real activator, no shell booted", () => {
  const out: string[] = [];
  for (const p of EDITOR_PLUGINS) {
    it(`${p.manifest.name} activates for real`, () => {
      try {
        activatePlugin(p);
        out.push(`${p.manifest.name}\tok`);
      } catch (e) {
        out.push(`${p.manifest.name}\tTHROWS: ${(e as Error).message}`);
        throw e;
      }
    });
  }
  it("all active, then deactivated cleanly", () => {
    const lines = ["B-RESULTS", ...out];
    lines.push(`asset kinds registered: ${assetKinds.list().length}, panels: ${panels.list().length}`);
    for (const p of EDITOR_PLUGINS) deactivatePlugin(p.manifest.name);
    expect(EDITOR_PLUGINS.some((p) => isPluginActive(p.manifest.name))).toBe(false);
    lines.push(`after deactivate: asset kinds ${assetKinds.list().length}, panels ${panels.list().length}`);
    writeFileSync("spikes/studio-editor-halves/results-B.txt", lines.join("\n") + "\n");
  });
});

describe("C: Studio order: core asset kinds first, then every half (id collisions, shared singletons)", () => {
  it("activates all 18 after registerCoreAssetKinds", async () => {
    const { registerCoreAssetKinds } = await import("../../src/editor/assetKinds.builtin");
    registerCoreAssetKinds();
    const core = assetKinds.list().length;
    const errors: string[] = [];
    for (const p of EDITOR_PLUGINS) {
      try {
        activatePlugin(p);
      } catch (e) {
        errors.push(`${p.manifest.name}: ${(e as Error).message}`);
      }
    }
    writeFileSync("spikes/studio-editor-halves/results-C.txt", `core kinds ${core}; after all halves ${assetKinds.list().length}; panels ${panels.list().length}; errors: ${errors.length ? errors.join(" | ") : "none"}\n`);
    for (const p of EDITOR_PLUGINS) deactivatePlugin(p.manifest.name);
    expect(errors).toEqual([]);
  });
});
