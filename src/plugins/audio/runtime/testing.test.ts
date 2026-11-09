// The K4 helpers themselves: the fake clock, the fake backend and the loopback host's cadence.
import { describe, expect, it } from "vitest";
import { Vector3 } from "../../../engine";
import { fakeHostClock } from "./core/hostClock";
import { createLoopbackHost, makeFakeBackend } from "./testing";

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
