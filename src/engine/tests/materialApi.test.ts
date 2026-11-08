// ADR 0107: scripts change materials through engine `Material` objects — the shared one per asset, or
// instances per renderer — with no Babylon types. Engine semantics here; the Babylon material library
// applying them is in `materialLibrary.test.ts`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Color, Engine, GameObject, Material, MeshRenderer, SceneManager, Vector2 } from "../index";

const RED = "asset:materials/red.material.json";
const BLUE = "asset:materials/blue.material.json";

describe("Material (ADR 0107)", () => {
  afterEach(() => Material._resetShared());

  it("is one shared Material per asset, whatever the spelling", () => {
    const a = Material.shared(RED);
    expect(Material.shared("materials/red.material.json")).toBe(a);
    expect(a.isInstance).toBe(false);
    expect(new Material(RED).isInstance).toBe(true);
  });

  it("sets, reads and clears values and keywords, bumping its version", () => {
    const m = new Material(RED);
    const v0 = m._version;
    m.setColor("color", Color.from("#00ff00"));
    m.setFloat("roughness", 0.2);
    m.setVector("Offset", new Vector2(1, 2));
    m.setTexture("texture", "asset:images/a.png");
    m.setKeyword("RIM", true);
    m.setKeyword("QUALITY", "HIGH");
    expect(m._version).toBeGreaterThan(v0);
    expect(m.getColor("color")?.toHex()).toBe("#00ff00");
    expect(m.getFloat("roughness")).toBe(0.2);
    expect(m.getVector("Offset")).toEqual(new Vector2(1, 2));
    expect(m.getTexture("texture")).toBe("asset:images/a.png");
    expect(m.isKeywordEnabled("RIM")).toBe(true);
    expect(m.getKeyword("QUALITY")).toBe("HIGH");
    expect(m.getFloat("color")).toBeUndefined(); // wrong type reads as unset
    m.clear("roughness");
    expect(m.hasOverride("roughness")).toBe(false);
    const v = m._version;
    m.setKeyword("RIM", true); // unchanged: no new version
    expect(m._version).toBe(v);
    m.clearAll();
    expect(m._empty).toBe(true);
  });

  it("copies values on clone, and copies stay independent", () => {
    const a = Material.shared(RED);
    const c = Color.from("#123456");
    a.setColor("color", c);
    c.r = 1; // the Material keeps its own copy
    const b = a.clone();
    expect(b.isInstance).toBe(true);
    expect(b.getColor("color")?.toHex()).toBe("#123456");
    a.setFloat("metalness", 1);
    expect(b.hasOverride("metalness")).toBe(false);
  });

  it("forgets shared values on reset (leaving play mode)", () => {
    const a = Material.shared(RED);
    a.setFloat("metalness", 1);
    Material._resetShared();
    expect(Material.shared(RED)._empty).toBe(true);
  });
});

describe("MeshRenderer.sharedMaterial / materialInstance (ADR 0107)", () => {
  let renderer: MeshRenderer;
  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    renderer = GameObject.create("box").addBehavior(MeshRenderer, { material: RED });
  });
  afterEach(() => Material._resetShared());

  it("reads the asset's shared Material, and draws it only once one exists", () => {
    expect(renderer._drawMaterial()?._empty ?? true).toBe(true); // nothing set: the asset draws as it is
    const shared = renderer.sharedMaterial!;
    expect(shared).toBe(Material.shared(RED));
    expect(renderer._drawMaterial()).toBe(shared);
  });

  it("makes its own instance once, from the shared values", () => {
    Material.shared(RED).setFloat("roughness", 0.1);
    const mine = renderer.materialInstance;
    expect(mine.isInstance).toBe(true);
    expect(mine.getFloat("roughness")).toBe(0.1);
    expect(renderer.materialInstance).toBe(mine);
    expect(renderer.sharedMaterial).toBe(mine);
    expect(renderer._drawMaterial()).toBe(mine);
  });

  it("assigns shared Materials by path and instances directly; changing the path drops an instance", () => {
    renderer.sharedMaterial = Material.shared(BLUE);
    expect(renderer.material).toBe(BLUE);
    const inst = new Material(RED);
    renderer.sharedMaterial = inst;
    expect(renderer.material).toBe(RED);
    expect(renderer.sharedMaterial).toBe(inst);
    // An assigned (not owned) instance is copied by materialInstance, as Unity copies a shared one.
    expect(renderer.materialInstance).not.toBe(inst);
    renderer.material = BLUE;
    expect(renderer.sharedMaterial).toBe(Material.shared(BLUE));
    renderer.sharedMaterial = null;
    expect(renderer.material).toBe("");
    expect(renderer.sharedMaterial).toBeNull();
  });

  it("treats sharedMaterial and materialInstance as slot 0, with other slots by index", () => {
    expect(renderer.getSharedMaterial(0)).toBe(renderer.sharedMaterial);
    expect(renderer.getMaterialInstance(0)).toBe(renderer.materialInstance);
    // Without material slots (ADR 0089), a slot past 0 draws `material` until it's given its own.
    expect(renderer.getSharedMaterial(1)).toBe(Material.shared(RED));
    renderer.setSharedMaterial(1, Material.shared(BLUE));
    expect(renderer.getSharedMaterial(1)).toBe(Material.shared(BLUE));
    expect(renderer.material).toBe(RED); // slot 0 untouched
    const one = renderer.getMaterialInstance(1);
    expect(one.asset).toBe(BLUE);
    expect(renderer._drawMaterial(1)).toBe(one);
    expect(renderer._drawMaterial(0)).not.toBe(one);
    expect(renderer.sharedMaterials).toEqual([renderer.getSharedMaterial(0), one]);
  });

  it("reads and writes `materials` slots once the renderer has them (ADR 0089's field)", () => {
    // ADR 0089 adds `materials: string[]`; simulated here, as the branches merge separately.
    const slotted = renderer as MeshRenderer & { materials: string[] };
    slotted.materials = ["", BLUE];
    expect(renderer.getSharedMaterial(0)).toBe(Material.shared(RED)); // empty entry: `material`
    expect(renderer.getSharedMaterial(1)).toBe(Material.shared(BLUE));
    renderer.setSharedMaterial(2, Material.shared(RED));
    expect(slotted.materials).toEqual(["", BLUE, RED]);
    renderer.sharedMaterial = Material.shared(BLUE); // slot 0 with no entry of its own: the renderer-wide `material`
    expect(renderer.material).toBe(BLUE);
    slotted.materials[0] = RED;
    renderer.setSharedMaterial(0, Material.shared(BLUE)); // slot 0 with its own entry: that entry
    expect(slotted.materials[0]).toBe(BLUE);
    const inst = renderer.getMaterialInstance(1);
    slotted.materials[1] = RED; // the slot's asset changed: its instance goes
    expect(renderer.getSharedMaterial(1)).not.toBe(inst);
    expect(renderer.sharedMaterials).toHaveLength(3);
  });

  it("gives a renderer without a material asset an instance of the default material", () => {
    renderer.material = "";
    expect(renderer.materialInstance.asset).toBe("");
  });
});

// The Babylon side (shared values in place, instances on their own copies, overrides over shared
// values) is tested through the material library in `materialLibrary.test.ts` (ADR 0127).
