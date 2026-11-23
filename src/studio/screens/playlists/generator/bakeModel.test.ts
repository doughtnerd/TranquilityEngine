// Bake and provenance (ADR 0360 §6, §9) through the model: Bake is off with why until G5's bake is merged, a baked
// sample's provenance says where it came from and "out of date" when the patch's hash differs, Rebake follows Bake.
import { describe, expect, it } from "vitest";
import { emptyGeneratorBody } from "../../../../engine/audio/generators/format";
import type { GeneratorBody } from "../../../../engine/audio/generators/types";
import { BAKE, BAKE_PENDING, bakeAvailability, cleanBakeOptions, defaultBakeOptions, generatorPatchHash, provenanceView, studioBake, type BakeGenerator, type OfflineBake } from "./bakeModel";

const fakeBake: BakeGenerator = async () => ({ files: [] });
const coin: GeneratorBody = { ...emptyGeneratorBody("blip"), seed: 1734, params: { ...emptyGeneratorBody("blip").params, baseFrequency: 0.42 } };

describe("Bake", () => {
  it("is off, saying why, until G5's bake is in the build", () => {
    expect(BAKE).toBeNull();
    expect(bakeAvailability(BAKE, "audio/ui/coin.generator.json")).toEqual({ enabled: false, reason: BAKE_PENDING });
  });

  it("is on with a bake, except for an embedded generator or a read-only project", () => {
    expect(bakeAvailability(fakeBake, "audio/ui/coin.generator.json")).toEqual({ enabled: true, reason: null });
    expect(bakeAvailability(fakeBake, null).enabled).toBe(false);
    expect(bakeAvailability(fakeBake, "a.generator.json", false).reason).toBe("This project is read-only.");
  });

  it("opens beside the generator and checks its options", () => {
    expect(defaultBakeOptions("audio/ui/coin.generator.json", false)).toEqual({ variations: 1, folder: "audio/ui", queue: false, replaceUses: false });
    expect(defaultBakeOptions("hum.generator.json", true).length).toBe(2);
    expect(cleanBakeOptions({ variations: 500, folder: "", queue: true, replaceUses: false, length: 0 })).toEqual({ variations: 64, folder: "", queue: true, replaceUses: false, length: 0.05 });
    expect(cleanBakeOptions({ variations: 1, folder: "", queue: true, replaceUses: false }).queue).toBe(false);
  });
});

describe("the Studio's bake over the offline bake", () => {
  it("passes the dialog's options, returns the files, and rejects a refusal or no project", async () => {
    const calls: unknown[] = [];
    const offline: OfflineBake<string> = async (path, options) => {
      calls.push([path, options]);
      return path.includes("silence") ? { refused: "a silence has nothing to bake" } : { files: [{ path: "audio/hum.baked.wav" }, { path: "audio/hum.baked2.wav" }], queue: "audio/hum.baked.playlist.json" };
    };
    const bake = studioBake(offline, () => "project");
    await expect(bake("audio/hum.generator.json", { length: 3, variations: 2, folder: "audio", queue: true, replaceUses: false })).resolves.toEqual({ files: ["audio/hum.baked.wav", "audio/hum.baked2.wav"], queue: "audio/hum.baked.playlist.json" });
    expect(calls[0]).toEqual(["audio/hum.generator.json", { host: "project", variations: 2, seconds: 3, folder: "audio", queue: true, replaceUses: false }]);
    await expect(bake("audio/silence.generator.json", { variations: 1, folder: "", queue: false, replaceUses: false })).rejects.toThrow("a silence has nothing to bake");
    await expect(studioBake(offline, () => null)("a.generator.json", { variations: 1, folder: "", queue: false, replaceUses: false })).rejects.toThrow("no project is open");
  });
});

describe("provenance", () => {
  const load = (bodies: Record<string, GeneratorBody>) => (p: string) => bodies[p] ?? null;
  const block = { generator: "audio/ui/coin.generator.json", hash: generatorPatchHash(coin), seed: 1734, variation: 0 };

  it("says where a sample was baked from, current while the patch hashes the same", () => {
    const v = provenanceView(block, load({ [block.generator]: { ...coin, note: "notes don't count" } }), null)!;
    expect(v).toMatchObject({ name: "coin.generator.json", state: "current", text: "Baked from coin.generator.json", note: null });
    expect(v.rebake).toEqual({ enabled: false, reason: BAKE_PENDING });
  });

  it("is out of date when the patch changed, with Rebake when there is a bake", () => {
    const changed = { ...coin, params: { ...coin.params, baseFrequency: 0.5 } };
    const v = provenanceView({ ...block, variation: 2 }, load({ [block.generator]: changed }), fakeBake)!;
    expect(v).toMatchObject({ state: "outOfDate", note: "out of date", text: "Baked from coin.generator.json · variation 3", rebake: { enabled: true } });
    expect(provenanceView({ ...block, seed: 1 }, load({ [block.generator]: { ...coin, seed: 1 } }), null)!.state).toBe("outOfDate");
  });

  it("notes a missing generator and has nothing to say without a block", () => {
    const v = provenanceView(block, load({}), fakeBake)!;
    expect(v.state).toBe("missing");
    expect(v.rebake.enabled).toBe(false);
    expect(provenanceView(null, load({}), fakeBake)).toBeNull();
  });
});
