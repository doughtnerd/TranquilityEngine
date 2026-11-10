// ADR 0158 E3.10: a group (the instance id PLAY carries) is free only once every voice that carried it has ended, and
// the group free longest is the next one taken, so a stopped instance's fading voices never follow a new instance's
// local parameters.
import { describe, expect, it, vi } from "vitest";
import { Audio } from "../index";
import { clip, ev, eventKit } from "./eventTestKit";
import { events } from "./eventRuntime";

const kit = eventKit();
const fake = kit.fake;
const EVENT = "e.audioevent.json";
const speed = () => ev(clip("a.wav"), { parameters: [{ name: "Speed", min: 0, max: 10 }], automation: [{ parameter: "Speed", target: "volume", curve: [[0, 0], [10, 1]] }] });
const warnCount = () => vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes("more than 1024 event instances at once")).length;

describe("group reuse (E3.10)", () => {
  it("a play right after a faded stop gets a different group, and its local parameter leaves the fading voice alone", async () => {
    await kit.boot({ [EVENT]: speed() });
    const a = Audio.play(EVENT, { parameters: { Speed: 5 } });
    events().update(1 / 60);
    expect(fake.voices[0].volume).toBeCloseTo(0.5);
    a.stop(0.5); // the voice is fading out: not playing, still alive
    expect(fake.voices[0].alive).toBe(true);
    const b = Audio.play(EVENT, { parameters: { Speed: 0 } });
    expect(fake.plays[1].group).toBeGreaterThan(0);
    expect(fake.plays[1].group).not.toBe(fake.plays[0].group);
    b.setParameter("Speed", 10);
    events().update(1 / 60);
    expect(fake.voices[1].volume).toBeCloseTo(1);
    expect(fake.voices[0].volume).toBeCloseTo(0.5); // the old voice kept its own Speed
  });

  it("a group comes back only after its last voice has ended", async () => {
    await kit.boot({ [EVENT]: ev({ type: "layer", children: [clip("a.wav"), clip("b.wav")] }) });
    const a = Audio.play(EVENT);
    const g = fake.plays[0].group;
    a.stop(0.5);
    // Exhaust the never-used groups; the held group must not be handed out while either voice is still fading.
    const rest: number[] = [];
    for (let i = 0; i < 1023; i++) { Audio.play(EVENT); rest.push(fake.plays.at(-1)!.group ?? -1); }
    expect(rest).not.toContain(g as number);
    Audio.play(EVENT); // one more: nothing free
    expect(fake.plays.at(-1)!.group).toBe(0);
    fake.voices[0].end(); // one of the two voices ends: still held
    Audio.play(EVENT);
    expect(fake.plays.at(-1)!.group).toBe(0);
    fake.voices[1].end(); // the last one ends: the group is free again
    Audio.play(EVENT);
    expect(fake.plays.at(-1)!.group).toBe(g);
  });

  it("free groups are taken longest-free first", async () => {
    await kit.boot({ [EVENT]: ev(clip("a.wav")) });
    const hs = [Audio.play(EVENT), Audio.play(EVENT), Audio.play(EVENT)];
    const [g1, g2] = [fake.plays[0].group, fake.plays[1].group];
    for (let i = 3; i < 1024; i++) Audio.play(EVENT);
    hs[0].stop(0); hs[1].stop(0); // g1 freed first, then g2
    Audio.play(EVENT);
    Audio.play(EVENT);
    expect(fake.plays.slice(-2).map((p) => p.group)).toEqual([g1, g2]);
  });

  it("a reused group's locals start from the new instance's values", async () => {
    await kit.boot({ [EVENT]: speed() });
    const first = Audio.play(EVENT, { parameters: { Speed: 8 } });
    const g = fake.plays[0].group;
    first.stop(0);
    for (let i = 1; i < 1024; i++) Audio.play(EVENT, { parameters: { Speed: 1 } });
    Audio.play(EVENT, { parameters: { Speed: 2 } }); // reuses g
    expect(fake.plays.at(-1)!.group).toBe(g);
    events().update(1 / 60);
    expect(fake.voices.at(-1)!.volume).toBeCloseTo(0.2);
  });

  it("1,025 live instances still warn once", async () => {
    await kit.boot({ [EVENT]: ev(clip("a.wav")) });
    for (let i = 0; i < 1025; i++) Audio.play(EVENT);
    Audio.play(EVENT);
    expect(fake.plays[1024].group).toBe(0);
    expect(warnCount()).toBe(1);
  });
});
