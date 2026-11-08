// ADR 0131: per-type Inspector extras come from a registry keyed by Component type, and load lazily.
import { describe, expect, it, vi } from "vitest";
import "./ui/inspectorSections.builtin";
import { inspectorSectionsFor, registerInspectorSection, registeredInspectorSections } from "./ui/inspectorSections";

describe("inspector sections", () => {
  it("registers the engine components' sections", () => {
    expect(registeredInspectorSections("engine.NavChunk")).toHaveLength(2);
    for (const type of ["engine.ParticleSystem", "engine.Tilemap", "engine.Environment", "engine.ReflectionProbe", "engine.NavAgent", "engine.NavAvoidanceObstacle", "engine.NavGroup", "engine.NavResolutionVolume", "engine.NavModifierVolume", "engine.NavCostVolume"]) {
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
    const types = ["engine.ParticleSystem", "engine.Tilemap", "engine.Environment", "engine.NavChunk", "engine.ReflectionProbe", "engine.NavAgent", "engine.NavAvoidanceObstacle", "engine.NavGroup", "engine.NavResolutionVolume", "engine.NavModifierVolume", "engine.NavCostVolume"];
    for (const type of types) {
      for (const view of registeredInspectorSections(type)) {
        await view.preload();
        expect(view.loaded, type).toBe(true);
      }
    }
  }, 60_000);
});
