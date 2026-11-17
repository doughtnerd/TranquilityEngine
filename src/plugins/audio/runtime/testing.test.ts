// The K4 helpers themselves: the fake clock, the fake backend and the loopback host's cadence.
import { afterEach, describe, expect, it } from "vitest";
import { Vector3 } from "../../../engine";
import { closeLoopbackAudio, createLoopbackHost, fakeHostClock, loopbackAudio, makeFakeBackend } from "./testing";
import { Op } from "./wire.generated";

describe("fakeHostClock", () => {
  it("advances every clock together, and the context clock only while running", () => {
    const c = fakeHostClock({ rafTime: 10, currentTime: 1, dateNow: 100 });
    expect(c.fake).toBe(true);
    c.advance(500);
    expect([c.rafTime(), c.currentTime(), c.dateNow()]).toEqual([510, 1.5, 600]);
    expect(c.outputTimestamp()).toEqual({ contextTime: 1.5, performanceTime: 510 });
    c.setRunning(false);
    c.advance(500);
    expect([c.rafTime(), c.currentTime(), c.dateNow()]).toEqual([1010, 1.5, 1100]);
    expect(c.outputTimestamp()).toBeNull();
  });
});

describe("makeFakeBackend", () => {
  it("records plays, voice calls and listener poses", () => {
    const b = makeFakeBackend();
    const v = b.play({ path: "a.wav", url: "a.wav", loop: false, stream: false, bus: "Master" })!;
    v.setVolume(0.5);
    v.setPosition({ x: 1, y: 2, z: 3 });
    expect(b.plays).toHaveLength(1);
    expect(b.voices[0]!.volume).toBe(0.5);
    expect(b.voices[0]!.position).toEqual({ x: 1, y: 2, z: 3 });
    v.stop();
    expect(v.playing).toBe(false);
    b.ready = false;
    expect(b.play({ path: "b.wav", url: "b.wav", loop: false, stream: false, bus: "Master" })).toBeNull();
  });
});

describe("makeFakeBackend listener", () => {
  it("copies Vector3 poses (getter-based x/y/z) by value", () => {
    const b = makeFakeBackend();
    const position = new Vector3(1, 2, 3);
    b.setListener({ position, forward: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0) });
    position.set(9, 9, 9);
    expect(b.listener!.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(b.listener!.forward).toEqual({ x: 0, y: 0, z: -1 });
    expect(b.listener!.up).toEqual({ x: 0, y: 1, z: 0 });
  });
});

describe("createLoopbackHost", () => {
  it("renders quanta, delivers STATUS every 6 and advances the clock", async () => {
    const host = await createLoopbackHost();
    const t0 = host.clock.currentTime();
    const out = host.renderQuanta(12);
    expect(out.left).toHaveLength(12 * 128);
    expect(host.statuses).toHaveLength(2);
    expect(host.clock.currentTime() - t0).toBeCloseTo((12 * 128) / 48_000, 6);
    expect(host.driver.pool.available).toBe(8);
  });
});

// ADR 0221: the loopback entry point is the production assembly over the loopback node.
describe("loopbackAudio", () => {
  afterEach(closeLoopbackAudio);
  const req = (path: string) => ({ path, url: path, loop: true, stream: false, bus: "Master" });

  it("starts with the core running, and the public Audio reaches it", async (ctx) => {
    const audio = await loopbackAudio();
    if (!audio) return ctx.skip();
    expect(audio.Audio.status).toBe("running");
    expect(audio.Audio.debug().core.backend).toBe("core");
    expect(audio.link.lastStatus).not.toBeNull();
    const voice = audio.backend.play(req("a.wav"))!;
    let level = 0;
    for (let f = 0; f < 20 && level === 0; f++) level = (await audio.step()).left.at(-1)!;
    expect(voice.playing).toBe(true);
    expect(level).toBeCloseTo(0.5, 2);
  });

  it("watches what reaches the core", async (ctx) => {
    const audio = await loopbackAudio({ mixer: "own" });
    if (!audio) return ctx.skip();
    const watch = audio.watch();
    audio.backend.play(req("a.wav"));
    await audio.step(10);
    expect(watch.take().some((r) => r.batch.records.some((x) => x.opcode === Op.PLAY))).toBe(true);
  });

  it("rebuilds after a trap and after a rate change, as the real host does", async (ctx) => {
    const audio = await loopbackAudio();
    if (!audio) return ctx.skip();
    audio.backend.play(req("a.wav"));
    await audio.step(10);
    audio.trap();
    audio.render(1);
    await audio.settle();
    expect(audio.host.health.traps).toBe(1);
    await audio.step(40);
    expect(audio.host.health.recoveries).toBe(1);
    expect((await audio.step()).left.at(-1)).toBeCloseTo(0.5, 2);
    expect(await audio.until(audio.changeRate(44_100))).toBe("rebuilt");
    expect(audio.sampleRate).toBe(44_100);
    expect(audio.Audio.debug().sampleRate).toBe(44_100);
  });
});
