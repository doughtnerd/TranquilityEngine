// ADR 0130: render features declare what they own, when they sync and whether they load lazily.
import { describe, expect, it, vi } from "vitest";
import { Component } from "../core/Component";
import type { World } from "../core/World";
import { SYNC_PHASES, byPhase, ownerOf, specNeeded, type RenderFeatureSpec } from "../render/renderFeatures";
import { eagerFeature, lazyFeature, type BabylonFeature } from "../render/babylon/feature";
import { ENVIRONMENT_SPEC, FOG_SPEC, LIGHTS_SPEC, PROBES_SPEC } from "../render/babylon/features";
import { WATER_SPEC } from "../../plugins/water/runtime";
import { TILEMAPS_SPEC } from "../../plugins/tilemaps/runtime";
import { MESHES_SPEC } from "../../plugins/meshes/runtime";
import { SPRITES_SPEC } from "../../plugins/sprites/runtime";
import { UI_SPEC } from "../../plugins/ui/runtime";
import { SKY_SPEC } from "../../plugins/sky/runtime";
import { PARTICLES_SPEC } from "../../plugins/particles/runtime";

class A extends Component {}
class B extends Component {}
class C extends B {}

const spec = (name: string, phase: RenderFeatureSpec["phase"], types: RenderFeatureSpec["types"] = [], extra: Partial<RenderFeatureSpec> = {}): RenderFeatureSpec => ({ name, phase, types, lazy: false, ...extra });
const worldWith = (...types: unknown[]) => ({ _componentsOfType: (t: unknown) => (types.includes(t) ? [{}] : []) }) as unknown as World;
const fake = (): BabylonFeature & { disposed: number } => {
  const f = { disposed: 0, sync: () => undefined, dispose: () => void f.disposed++ };
  return f;
};

describe("render feature ordering (ADR 0130)", () => {
  // The renderer's documented dependencies, as the registration in BabylonRenderer gives them.
  const specs = [
    spec("ui", "overlay"),
    spec("probes", "capture"),
    spec("water", "surfaces"),
    spec("particles", "effects"),
    spec("sky", "lighting"),
    spec("lights", "lighting"),
    spec("fog", "lighting"),
    spec("sprites", "content"),
    spec("tilemaps", "content"),
    spec("meshes", "content"),
  ];
  const order = byPhase(specs).map((i) => specs[i].name);
  const before = (a: string, b: string) => expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));

  it("runs phases in order, and registration order inside a phase", () => {
    expect(order).toEqual(["sprites", "tilemaps", "meshes", "sky", "lights", "fog", "particles", "probes", "water", "ui"]);
    expect(SYNC_PHASES).toEqual(["content", "lighting", "effects", "capture", "surfaces", "overlay"]);
  });
  it("syncs the sky before lights (the sky may drive the sun)", () => before("sky", "lights"));
  it("captures probes after meshes, and after effects (when readiness is known)", () => {
    before("meshes", "probes");
    before("particles", "probes");
  });
  it("syncs UI last", () => expect(order.at(-1)).toBe("ui"));
});

describe("render feature ordering constraints (ADR 0135)", () => {
  const names = (specs: RenderFeatureSpec[]) => byPhase(specs).map((i) => specs[i].name);

  it("keeps the built-ins' order with plugins' features (sky, tilemaps) registered last", () => {
    const specs = [SPRITES_SPEC, MESHES_SPEC, LIGHTS_SPEC, FOG_SPEC, ENVIRONMENT_SPEC, PARTICLES_SPEC, PROBES_SPEC, WATER_SPEC, UI_SPEC, SKY_SPEC, TILEMAPS_SPEC];
    expect(names(specs)).toEqual(["sprites", "tilemaps", "meshes", "sky", "lights", "fog", "environment", "particles", "probes", "water", "ui"]);
    // Without the Sky and Tilemaps plugins, the rest keep their order.
    expect(names(specs.slice(0, -2))).toEqual(["sprites", "meshes", "lights", "fog", "environment", "particles", "probes", "water", "ui"]);
    // Registered in any order, the constraints still hold.
    expect(names([ENVIRONMENT_SPEC, FOG_SPEC, LIGHTS_SPEC, SKY_SPEC, MESHES_SPEC, TILEMAPS_SPEC, SPRITES_SPEC]).join()).toBe("sprites,tilemaps,meshes,sky,lights,fog,environment");
  });

  it("is a stable sort: unconstrained features keep registration order", () => {
    const specs = [spec("a", "lighting"), spec("b", "lighting", [], { after: ["d"] }), spec("c", "lighting"), spec("d", "lighting")];
    expect(names(specs)).toEqual(["a", "c", "d", "b"]);
  });

  it("ignores names of absent features and of other phases", () => {
    const specs = [spec("x", "lighting", [], { after: ["missing", "y"] }), spec("y", "content")];
    expect(names(specs)).toEqual(["y", "x"]);
  });

  it("throws on a cycle, naming the features", () => {
    const specs = [spec("a", "effects", [], { after: ["b"] }), spec("b", "effects", [], { after: ["a"] }), spec("c", "effects")];
    expect(() => byPhase(specs)).toThrow(/"a", "b".*cycle.*effects/);
  });
});

describe("ownership (ADR 0130)", () => {
  it("gives a Component to the first spec that owns it, subclasses included", () => {
    const specs = [spec("a", "content", [A]), spec("b", "content", [B]), spec("anyB", "overlay", [B])];
    expect(ownerOf(specs, new A())).toBe(0);
    expect(ownerOf(specs, new C())).toBe(1);
    expect(ownerOf(specs, new (class extends Component {})())).toBe(-1);
  });
  it("lets a spec's own predicate decide (UI owns Text before anything else)", () => {
    const specs = [spec("ui", "overlay", [A], { owns: (c) => c instanceof B }), spec("b", "content", [B])];
    expect(ownerOf(specs, new B())).toBe(0);
    expect(ownerOf(specs, new A())).toBe(-1);
  });
  it("needs a lazy feature once the World has one of its types, unless `needed` says otherwise", () => {
    expect(specNeeded(spec("a", "content", [A, B]), worldWith(B))).toBe(true);
    expect(specNeeded(spec("a", "content", [A]), worldWith(B))).toBe(false);
    expect(specNeeded(spec("a", "content", [A], { needed: () => true }), worldWith())).toBe(true);
  });
});

describe("feature slots (ADR 0130)", () => {
  it("an eager feature is there from the start and disposes once", () => {
    const f = fake();
    const slot = eagerFeature(spec("e", "content"), f);
    expect(slot.ensure()).toBe(f);
    slot.dispose();
    slot.dispose();
    expect(f.disposed).toBe(1);
    expect(slot.feature).toBeNull();
  });

  it("a lazy feature loads once, when the World first needs it", async () => {
    const f = fake();
    const load = vi.fn(async () => f);
    const slot = lazyFeature(spec("l", "effects", [A], { lazy: true }), load);
    expect(slot.ensure(worldWith())).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(slot.ensure(worldWith(A))).toBeNull();
    expect(slot.loading).toBe(true);
    slot.ensure(worldWith(A));
    await vi.waitFor(() => expect(slot.feature).toBe(f));
    expect(slot.loading).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(slot.ensure(worldWith())).toBe(f);
  });

  it("disposes a feature that finishes loading after the slot was disposed", async () => {
    const f = fake();
    let resolve!: (v: typeof f) => void;
    const slot = lazyFeature(spec("l", "effects", [], { lazy: true }), () => new Promise<typeof f>((r) => (resolve = r)));
    slot.ensure();
    slot.dispose();
    resolve(f);
    await vi.waitFor(() => expect(f.disposed).toBe(1));
    expect(slot.feature).toBeNull();
    expect(slot.ensure()).toBeNull();
  });

  it("lets the load skip building when the slot was disposed meanwhile", async () => {
    let resolve!: () => void;
    const built = vi.fn(() => fake());
    const slot = lazyFeature(spec("l", "effects", [], { lazy: true }), (cancelled) => new Promise<void>((r) => (resolve = r)).then(() => (cancelled() ? null : built())));
    slot.ensure();
    slot.dispose();
    resolve();
    await vi.waitFor(() => expect(slot.loading).toBe(false));
    expect(built).not.toHaveBeenCalled();
    expect(slot.feature).toBeNull();
  });

  it("logs a failed load and tries again at the next need", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fake();
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(f);
    const slot = lazyFeature(spec("l", "effects", [], { lazy: true }), load);
    slot.ensure();
    await vi.waitFor(() => expect(slot.loading).toBe(false));
    expect(error).toHaveBeenCalled();
    expect(slot.feature).toBeNull();
    slot.ensure();
    await vi.waitFor(() => expect(slot.feature).toBe(f));
    error.mockRestore();
  });
});
