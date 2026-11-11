import { describe, expect, it } from "vitest";
import { importSettingsJSON, parseImportSettings, type ImportSettings } from "../../engine/scene/importSettings";
import { multichannelWarning, orderChoice, setAmbisonicConvention, setAmbisonicOrder, toggleAmbisonic } from "./ambisonicBlock";

const base = (): ImportSettings => parseImportSettings({ format: "myco.import@1" }).settings;
const json = (s: ImportSettings) => importSettingsJSON(s);

describe("Ambisonic block edits", () => {
  it("toggling on with defaults writes an empty object; off removes the key", () => {
    const on = { ...base(), ...toggleAmbisonic(true) };
    expect(json(on).ambisonic).toEqual({});
    expect("ambisonic" in json({ ...on, ...toggleAmbisonic(false) })).toBe(false);
  });
  it("writes only non-default keys", () => {
    let s = { ...base(), ...toggleAmbisonic(true) };
    s = { ...s, ...setAmbisonicOrder(s.ambisonic!, "2") };
    expect(json(s).ambisonic).toEqual({ order: 2 });
    s = { ...s, ...setAmbisonicConvention(s.ambisonic!, "fuma") };
    expect(json(s).ambisonic).toEqual({ order: 2, convention: "fuma" });
    s = { ...s, ...setAmbisonicOrder(s.ambisonic!, "auto") };
    s = { ...s, ...setAmbisonicConvention(s.ambisonic!, "ambix") };
    expect(json(s).ambisonic).toEqual({});
  });
  it("reads back an existing sidecar", () => {
    const { settings } = parseImportSettings({ format: "myco.import@1", ambisonic: { order: 3, convention: "fuma" } });
    expect(settings.ambisonic).toEqual({ order: 3, convention: "fuma" });
    expect(orderChoice(settings.ambisonic!)).toBe("3");
    expect(orderChoice(parseImportSettings({ format: "myco.import@1", ambisonic: {} }).settings.ambisonic!)).toBe("auto");
  });
});

describe("multichannelWarning", () => {
  it("warns for over 2 channels without a sidecar only", () => {
    expect(multichannelWarning(6, null)).toBe("6-channel audio needs an ambisonic import setting (ADR 0162); multichannel mixes aren't supported");
    expect(multichannelWarning(6, { order: null, convention: "ambix" })).toBeNull();
    expect(multichannelWarning(2, null)).toBeNull();
    expect(multichannelWarning(null, null)).toBeNull();
  });
});
