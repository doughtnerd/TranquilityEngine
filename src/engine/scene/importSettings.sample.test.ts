// The sidecar's optional `sample` block (ADR 0342) through the sidecar parse and writer.
import { describe, expect, it } from "vitest";
import { defaultImportSettings, formatImportSettings, parseImportSettings } from "./importSettings";

describe("the sidecar's sample block", () => {
  it("leaves old sidecars as they were", () => {
    const raw = { format: "myco.import@1", volume: 0.8, loopStart: 1.5, loopEnd: 7.25 };
    const { settings, problems } = parseImportSettings(raw, "a.wav.meta.json");
    expect(problems).toEqual([]);
    expect(settings.sample).toBeNull();
    expect(JSON.parse(formatImportSettings(settings))).toEqual(raw);
    expect(defaultImportSettings().sample).toBeNull();
  });

  it("parses the block and writes it back", () => {
    const raw = {
      format: "myco.import@1", stream: true,
      sample: {
        kind: "sustain", trim: [0.02, 2.58],
        loops: [{ id: "l1", start: 0.45, end: 1.55, direction: "pingPong", crossfadeMs: 35, count: 0, active: "held", exit: "finish", exitFadeMs: 40, reentry: "ignore", file: null }],
        markers: [{ id: "m1", type: "cue", name: "brake_lockup", at: 0.3, file: null }],
        closedGaps: [[0.8, 0.4]],
      },
    };
    const { settings, problems } = parseImportSettings(raw, "a.wav.meta.json");
    expect(problems).toEqual([]);
    expect(settings.sample?.loops[0].direction).toBe("pingPong");
    const text = formatImportSettings(settings);
    expect(JSON.parse(text)).toEqual(raw);
    expect(text).toContain('"trim": [0.02, 2.58]');
    expect(parseImportSettings(JSON.parse(text)).settings).toEqual(settings);
  });

  it("reports problems in the block under the sidecar's name without failing the rest", () => {
    const { settings, problems } = parseImportSettings({ format: "myco.import@1", volume: 0.5, sample: { kind: "drone", loops: "none" } }, "a.wav.meta.json");
    expect(settings.volume).toBe(0.5);
    expect(settings.sample?.kind).toBe("oneshot");
    expect(problems).toEqual([
      'a.wav.meta.json: sample.kind: must be one of oneshot, loop, sustain, music; using "oneshot".',
      "a.wav.meta.json: sample.loops: must be a list; ignored.",
    ]);
  });

  it("reads a null block as none", () => {
    expect(parseImportSettings({ format: "myco.import@1", sample: null }).settings.sample).toBeNull();
  });
});
