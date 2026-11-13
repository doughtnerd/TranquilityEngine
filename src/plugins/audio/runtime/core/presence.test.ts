// Dp1 (api-and-models §4.2 `BUS_DUCK`, `BUS_PRESENCE`): what presence sends, on a fake writer and clock. A record's
// mask is the presence at its own frame; a stamped change waiting for its frame is sent again when a later-written,
// earlier-applying change alters the mask there; rules carry presence rules only, as slots.
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import type { BusDuckRules } from "../wire.generated";
import { Presence } from "./presence";
import { VoiceState } from "./voiceTable";

/** Rules triggering on Music (1), SFX (2) and UI (3), ducking Voice. */
const triggers = (): AudioSettings => ({
  ...defaultAudioSettings(),
  ducking: ["Music", "SFX", "UI"].map((trigger) => ({ target: "Voice", trigger, mode: "presence" as const, amount: 0.5, attack: 0.1, release: 0.1 })),
});

function rig(settings: AudioSettings = triggers()) {
  const sent: { mask: number; at: number | undefined }[] = [];
  const ducks: BusDuckRules[][] = [];
  const cap = 8;
  const table = { capacity: cap, state: new Uint8Array(cap), bus: new Uint8Array(cap), startFrame: new Float64Array(cap) };
  let framesNow = 500;
  const host = {
    writer: { busDuck: (r: readonly BusDuckRules[]) => void ducks.push([...r]), busPresence: (mask: number, at?: number) => void sent.push({ mask, at }) },
    table,
    clockMap: { stampFor: (f: number) => (f > framesNow ? f : undefined) },
    mixer: new Mixer(settings),
  };
  const p = new Presence(host as never);
  const start = (slot: number, bus: number, frame = 0) => {
    table.state[slot] = VoiceState.PLAYING;
    table.bus[slot] = bus;
    table.startFrame[slot] = frame;
    p.voiceStarted(bus, slot);
  };
  return { p, sent, ducks, table, start, setNow: (f: number) => (framesNow = f), mixer: host.mixer };
}

describe("presence (Dp1)", () => {
  it("configure sends the presence rules as slots (level rules and unknown buses left out) and the mask", () => {
    const s: AudioSettings = {
      ...defaultAudioSettings(),
      ducking: [
        { target: "Music", trigger: "Voice", mode: "presence", amount: 0.4, attack: 0.1, release: 0.5 },
        { target: "Music", trigger: "SFX", mode: "level", amount: 0.5, attack: 0.1, release: 0.5 },
        { target: "Music", trigger: "Nope", amount: 0.5, attack: 0.1, release: 0.5 },
        { target: "SFX", trigger: "UI", amount: 0.7, attack: 0, release: 0.2 },
      ],
    };
    const r = rig(s);
    r.table.state[3] = VoiceState.VIRTUAL;
    r.table.bus[3] = 2;
    r.table.state[4] = VoiceState.STOPPING;
    r.table.bus[4] = 1;
    r.p.configured(r.mixer, []);
    const names = r.mixer.busNames;
    expect(r.ducks).toEqual([
      [
        { target: names.indexOf("Music"), trigger: names.indexOf("Voice"), flags: 0, thresholdDb: -30, amount: 0.4, attack: 0.1, release: 0.5 },
        { target: names.indexOf("SFX"), trigger: names.indexOf("UI"), flags: 0, thresholdDb: -30, amount: 0.7, attack: 0, release: 0.2 },
      ],
    ]);
    expect(r.sent).toEqual([{ mask: 1 << 2, at: undefined }]);
    // The same settings object: nothing new; a new ducking list: sent again.
    r.p.settingsChanged(r.mixer);
    expect(r.ducks).toHaveLength(1);
  });

  it("a slot no rule triggers on sends nothing; its bit rides along", () => {
    const r = rig({ ...defaultAudioSettings(), ducking: [{ target: "Music", trigger: "SFX", mode: "presence", amount: 0.5, attack: 0, release: 0 }] });
    r.p.configured(r.mixer, []);
    r.sent.length = 0;
    r.start(0, 3, 1_000); // UI: no rule
    r.start(1, 1);
    expect(r.sent).toEqual([]);
    r.start(2, 2);
    expect(r.sent).toEqual([{ mask: (1 << 1) | (1 << 2) | (1 << 3), at: undefined }]);
    // New rules: the mask goes again with them.
    r.p.writeDucking([{ target: "Music", trigger: "UI", mode: "presence", amount: 0.5, attack: 0, release: 0 }]);
    expect(r.ducks.at(-1)!.map((x) => x.trigger)).toEqual([3]);
    expect(r.sent.at(-1)).toEqual({ mask: (1 << 1) | (1 << 2) | (1 << 3), at: undefined });
  });

  it("a bit change goes out once per bus (asap or at the start frame); explicit stop then free counts once", () => {
    const r = rig();
    r.p.configured(r.mixer, []);
    r.sent.length = 0;
    r.start(0, 1);
    r.start(1, 1);
    expect(r.sent).toEqual([{ mask: 2, at: undefined }]);
    r.p.voiceStopped(1, 0);
    expect(r.sent).toHaveLength(1);
    r.p.voiceStopped(1, 1);
    r.p.voiceStopped(1, 1); // its free after the explicit stop
    expect(r.sent).toEqual([{ mask: 2, at: undefined }, { mask: 0, at: undefined }]);
    // A stopping voice moved to another bus doesn't count again.
    r.table.state[1] = VoiceState.STOPPING;
    r.p.voiceStarted(3, 1);
    expect(r.sent).toHaveLength(2);
  });

  it("each record's mask is the presence at its frame; a waiting stamped record is corrected by a later earlier change", () => {
    const r = rig();
    r.p.configured(r.mixer, []);
    r.sent.length = 0;
    r.start(0, 2, 1_000); // stamped ahead of F_now = 500
    expect(r.sent).toEqual([{ mask: 1 << 2, at: 1_000 }]);
    r.start(1, 1); // asap: bus 2's voice hasn't started yet
    expect(r.sent.slice(1)).toEqual([
      { mask: 1 << 1, at: undefined },
      { mask: (1 << 1) | (1 << 2), at: 1_000 },
    ]);
    r.p.voiceStopped(1, 1);
    expect(r.sent.slice(3)).toEqual([
      { mask: 0, at: undefined },
      { mask: 1 << 2, at: 1_000 },
    ]);
    // Past its frame the change has applied: no more corrections.
    r.setNow(2_000);
    r.start(2, 3);
    expect(r.sent.slice(5)).toEqual([{ mask: (1 << 2) | (1 << 3), at: undefined }]);
    expect(r.p.mask).toBe((1 << 2) | (1 << 3));
  });
});
