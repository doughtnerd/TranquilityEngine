// ADR 0131: per-type Inspector extras come from a registry keyed by Component type, and load lazily.
import { describe, expect, it, vi } from "vitest";
import "./ui/inspectorSections.builtin";
import { inspectorSectionsFor, registerInspectorSection, registeredInspectorSections } from "./ui/inspectorSections";

describe("inspector sections", () => {
  // The ParticleSystem's section is the Particles plugin's (src/plugins/particles/particles.test.ts), the navigation components' the Navigation plugin's.
  it("registers the engine components' sections", () => {
    for (const type of ["engine.Tilemap", "engine.Environment", "engine.ReflectionProbe"]) {
      expect(registeredInspectorSections(type), type).toHaveLength(1);
    }
    expect(registeredInspectorSections("engine.Transform")).toHaveLength(0);
  });

  it("loads nothing until a section is rendered or preloaded", async () => {
    const load = vi.fn(async () => () => null);
    registerInspectorSection("test.sections.Lazy", load);
    const [view] = registeredInspectorSections("test.sections.Lazy");
    expect(load).not.toHaveBeenCalled();
    expect(view.loaded).toBe(false);
    await view.preload();
    expect(load).toHaveBeenCalledTimes(1);
    expect(view.loaded).toBe(true);
  });

  it("filters by selection: always, single node, or top-level node only", () => {
    const none = async () => () => null;
    registerInspectorSection("test.sections.Filter", none);
    registerInspectorSection("test.sections.Filter", none, { single: true });
    registerInspectorSection("test.sections.Filter", none, { rootOnly: true });
    expect(inspectorSectionsFor("test.sections.Filter", [["a"]])).toHaveLength(3);
    expect(inspectorSectionsFor("test.sections.Filter", [["a", "b"]])).toHaveLength(2);
    expect(inspectorSectionsFor("test.sections.Filter", [["a"], ["c"]])).toHaveLength(1);
  });

  it("each built-in section's module loads and exports its component", async () => {
    const types = ["engine.Tilemap", "engine.Environment", "engine.ReflectionProbe"];
    for (const type of types) {
      for (const view of registeredInspectorSections(type)) {
        await view.preload();
        expect(view.loaded, type).toBe(true);
      }
    }
  }, 60_000);
});
