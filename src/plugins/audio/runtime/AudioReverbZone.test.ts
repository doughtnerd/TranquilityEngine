// ADR 0162 C5: the AudioReverbZone component (§1.5, R10, R17).
import { beforeEach, describe, expect, it } from "vitest";
import { getFields, resolveChoices } from "../../../engine/core/registry";
import { defaultSettings } from "../../../engine/core/settings";
import { Assets, Engine, GameObject, SceneManager, Vector3 } from "../../../myco";
import { AudioReverbZone, ZONE_PRESETS } from "./AudioReverbZone";

beforeEach(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  await Engine.create({ headless: true });
  await SceneManager.load("s.json");
});

describe("AudioReverbZone", () => {
  it("has the ten §1.5 fields with defaults and descriptions", () => {
    const fields = getFields(AudioReverbZone);
    expect(fields.map((f) => f.name)).toEqual(["shape", "center", "size", "radius", "preset", "ir", "wet", "blendDistance", "priority", "output"]);
    for (const f of fields) expect(JSON.stringify(f), f.name).toMatch(/"description":"\S/);
    const z = GameObject.create("zone").addBehavior(AudioReverbZone);
    expect([z.shape, z.radius, z.preset, z.ir, z.wet, z.blendDistance, z.priority, z.output]).toEqual(["box", 5, "hall", "", 0.5, 2, 0, ""]);
    expect(z.center).toEqual(new Vector3(0, 0, 0));
    expect(z.size).toEqual(new Vector3(10, 4, 10));
  });

  it("offers the R10 presets, the two shapes, and the project's buses for output (empty is Master, R17)", () => {
    expect([...ZONE_PRESETS]).toEqual(["room", "corridor", "hall", "cave", "open"]);
    const byName = new Map(getFields(AudioReverbZone).map((f) => [f.name, f]));
    const values = (name: string) => resolveChoices(byName.get(name)!.options?.choices, defaultSettings)!.map((c) => c.value);
    expect(values("preset")).toEqual([...ZONE_PRESETS]);
    expect(values("shape")).toEqual(["box", "sphere"]);
    const settings = defaultSettings;
    expect(values("output")).toEqual(["", ...settings.audio.buses.map((b) => b.name)]);
    expect(byName.get("ir")!.options?.kind).toBe("audio");
  });
});
