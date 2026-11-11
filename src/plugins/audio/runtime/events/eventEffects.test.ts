// ADR 0162 D4 (api-and-models §2.5): an event's `filter`, `sends` and `spatial` additions reach each voice's PlayRequest.
import { describe, expect, it } from "vitest";
import { Audio } from "../index";
import { clip, ev, eventKit } from "./eventTestKit";

const kit = eventKit();
const spatial = { minDistance: 1, maxDistance: 30, rolloff: "inverse" };
const warnings = (): string[] => (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

describe("event effects (ADR 0162 §2.5)", () => {
  it("a flat event's filter reaches the voice; the reverb send is ignored", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav"), { filter: { lowpass: 9000, highpass: 80 }, sends: { reverb: 0.5 } }) });
    Audio.play("e.audioevent.json");
    const req = kit.fake.plays[0];
    expect(req.filter).toEqual({ lowpass: 9000, highpass: 80 });
    expect(req.reverbSend).toBeUndefined();
    expect(req.occlusion).toBeUndefined();
    expect(req.dopplerLevel).toBeUndefined();
    expect(req.reverbSendCurve).toBeUndefined();
  });

  it("a flat event ignores spatial keys, even when the source passes options", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav"), { spatial: { enabled: false, occlusion: false, dopplerLevel: 3 } }) });
    Audio.play("e.audioevent.json", { position: { x: 0, y: 0, z: 1 }, dopplerLevel: 4, reverbSend: 2 });
    const req = kit.fake.plays[0];
    expect(req.dopplerLevel).toBeUndefined();
    expect(req.reverbSend).toBeUndefined();
    expect(req.attenuation).toBeUndefined();
  });

  it("a spatial event carries occlusion, dopplerLevel, reverbSend and its curve", async () => {
    const curve = [[0, 1], [1, 0.2]];
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav"), {
      spatial: { ...spatial, occlusion: false, dopplerLevel: 2, reverbSendCurve: curve }, sends: { reverb: 1.5 },
    }) });
    Audio.play("e.audioevent.json", { position: { x: 1, y: 0, z: 2 } });
    const req = kit.fake.plays[0];
    expect(req.occlusion).toBe(false);
    expect(req.dopplerLevel).toBe(2);
    expect(req.reverbSend).toBe(1.5);
    expect(req.reverbSendCurve).toEqual(curve);
  });

  it("sends only what the file sets (the backend applies the defaults)", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav"), { spatial }) });
    Audio.play("e.audioevent.json", { position: { x: 0, y: 0, z: 1 } });
    const req = kit.fake.plays[0];
    for (const k of ["occlusion", "dopplerLevel", "reverbSend", "reverbSendCurve", "filter", "aux"] as const) expect(req[k]).toBeUndefined();
  });

  it("the source's options apply where the asset sets none, and the asset's keys win", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav"), { spatial: { ...spatial, dopplerLevel: 0.5 } }) });
    Audio.play("e.audioevent.json", { position: { x: 0, y: 0, z: 1 }, dopplerLevel: 4, occlusion: false, reverbSend: 0.25 });
    const req = kit.fake.plays[0];
    expect(req.dopplerLevel).toBe(0.5);
    expect(req.occlusion).toBe(false);
    expect(req.reverbSend).toBe(0.25);
  });

  it("an aux send resolves the bus by name, on flat and spatial events", async () => {
    await kit.boot({
      "f.audioevent.json": ev(clip("a.wav"), { sends: { SFX: 0.3 } }),
      "s.audioevent.json": ev(clip("a.wav"), { spatial, sends: { reverb: 0.5, SFX: 2 } }),
    });
    Audio.play("f.audioevent.json");
    Audio.play("s.audioevent.json", { position: { x: 0, y: 0, z: 1 } });
    expect(kit.fake.plays[0].aux).toEqual({ bus: "SFX", level: 0.3 });
    expect(kit.fake.plays[0].reverbSend).toBeUndefined();
    expect(kit.fake.plays[1].aux).toEqual({ bus: "SFX", level: 2 });
    expect(kit.fake.plays[1].reverbSend).toBe(0.5);
  });

  it("an unknown aux bus is dropped with one warning", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav"), { sends: { Nowhere: 0.4 } }) });
    Audio.play("e.audioevent.json");
    Audio.play("e.audioevent.json");
    expect(kit.fake.plays).toHaveLength(2);
    for (const p of kit.fake.plays) expect(p.aux).toBeUndefined();
    expect(warnings().filter((w) => w.includes("Nowhere"))).toHaveLength(1);
  });

  it("the second aux key is reported by the parse and only the first is sent", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav"), { sends: { SFX: 0.3, Master: 0.6 } }) });
    Audio.play("e.audioevent.json");
    expect(kit.fake.plays[0].aux).toEqual({ bus: "SFX", level: 0.3 });
    expect(warnings().some((w) => w.includes("sends.Master") && w.includes("one aux send"))).toBe(true);
  });
});
