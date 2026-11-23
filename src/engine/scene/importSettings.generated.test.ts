// The sidecar's optional `generated` block (ADR 0360 §6) through the sidecar parse and writer.
import { describe, expect, it } from "vitest";
import { defaultImportSettings, formatImportSettings, parseImportSettings } from "./importSettings";

describe("the sidecar's generated block", () => {
  it("is absent from old sidecars and defaults", () => {
    const raw = { format: "myco.import@1", volume: 0.8 };
    const { settings, problems } = parseImportSettings(raw, "a.wav.meta.json");
    expect(problems).toEqual([]);
    expect(settings.generated).toBeNull();
    expect(JSON.parse(formatImportSettings(settings))).toEqual(raw);
    expect(defaultImportSettings().generated).toBeNull();
  });

  it("parses beside the sample block and writes back", () => {
    const raw = {
      format: "myco.import@1",
      sample: { kind: "oneshot" },
      generated: { generator: "audio/ui/coin.generator.json", hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", seed: 1734, variation: 1 },
    };
    const { settings, problems } = parseImportSettings(raw, "coin.baked.wav.meta.json");
    expect(problems).toEqual([]);
    expect(settings.generated).toEqual(raw.generated);
    const again = parseImportSettings(JSON.parse(formatImportSettings(settings)));
    expect(again.settings).toEqual(settings);
    expect(JSON.parse(formatImportSettings(settings)).generated).toEqual(raw.generated);
  });

  it("drops a block without a generator, with one problem", () => {
    const { settings, problems } = parseImportSettings({ format: "myco.import@1", generated: { seed: 3 } }, "x.wav.meta.json");
    expect(settings.generated).toBeNull();
    expect(problems).toEqual(['x.wav.meta.json: generated: needs a "generator" path; dropped.']);
  });
});
