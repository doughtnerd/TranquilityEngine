// `mix.op` through `applyMixOpCommand`: a real `Mixer` with a recording live target, ops as the tool sends them.
import { describe, expect, it } from "vitest";
import { CORE_LIVE_CAPS } from "../../../../engine/audio/busCapability";
import { Mixer } from "../../../../engine/audio/mixer";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { currentMixOpOrigin } from "../capture/mixOpOrigin";
import { applyMixOpCommand } from "./mixCommands";
import { mixOpCommand } from "./schema";

const AUDIO = { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "SFX", parent: "Master" }] };

function rig() {
  const m = new Mixer(parseAudioSettings(AUDIO).settings);
  const sent: MixOp[] = [];
  m._setOpTarget({
    liveCaps: CORE_LIVE_CAPS,
    sendOp: (op, cls) => {
      sent.push(op);
      m._applyLive(op);
      return { ok: true, class: cls };
    },
    notSent: () => {},
  });
  return { m, sent };
}

const busVolume = (bus: string, value: number): MixOp => ({ op: "setBus", bus, key: "volume", value });
const volume = (m: Mixer, name: string) => m.audioSettings.buses.find((b) => b.name === name)?.volume;

describe("mix.op command", () => {
  it("applies a bus volume op", () => {
    const { m, sent } = rig();
    expect(applyMixOpCommand(mixOpCommand(busVolume("Music", 0.25)), m).ok).toBe(true);
    expect(sent).toEqual([busVolume("Music", 0.25)]);
    expect(volume(m, "Music")).toBe(0.25);
  });

  it("applies the op as the debug link's, so a capture's MIXOP record names a tool (origin debugLink), not the editor", () => {
    const { m } = rig();
    let origin = "";
    applyMixOpCommand(mixOpCommand(busVolume("Music", 0.5)), { apply: (op) => ((origin = currentMixOpOrigin()), m.apply(op)) });
    expect(origin).toBe("debugLink");
    expect(currentMixOpOrigin()).toBe("editor"); // restored after
  });

  it("refuses an unknown bus with a message naming it", () => {
    const { m, sent } = rig();
    expect(() => applyMixOpCommand(mixOpCommand(busVolume("Nope", 0.5)), m)).toThrow(/No bus named "Nope"/);
    expect(sent).toEqual([]);
  });

  it("refuses a bad value and a command that doesn't read", () => {
    const { m } = rig();
    const bad = mixOpCommand({ op: "setBus", bus: "Music", key: "volume", value: "loud" } as unknown as MixOp);
    expect(() => applyMixOpCommand(bad, m)).toThrow(/must be a number/);
    const unknownKey = { ...mixOpCommand(busVolume("Music", 1)), op: 9999 };
    expect(() => applyMixOpCommand(unknownKey, m)).toThrow(Error);
    expect(() => applyMixOpCommand({ nope: 1 }, m)).toThrow(/mix.op needs/);
  });

  it("maps names through the carried tables: the same bus id means a different bus in each command", () => {
    const { m } = rig();
    const a = mixOpCommand(busVolume("SFX", 0.1));
    const b = mixOpCommand(busVolume("Music", 0.6));
    expect(a.buses).toEqual(["SFX"]); // each table starts at 0, so only the carried tables tell the buses apart
    expect(b.buses).toEqual(["Music"]);
    applyMixOpCommand(a, m);
    applyMixOpCommand(b, m);
    expect(volume(m, "SFX")).toBe(0.1);
    expect(volume(m, "Music")).toBe(0.6);
  });

  it("throws when the mixer has no live backend", () => {
    const m = new Mixer(parseAudioSettings(AUDIO).settings);
    expect(() => applyMixOpCommand(mixOpCommand(busVolume("Music", 0.5)), m)).toThrow(/no live audio backend/);
  });
});
