// A1.6 L2: one case per row of api-and-models §1 (K10). Skeleton: the leaf fills these in.
import { describe, it } from "vitest";

describe("Audio public surface (api-and-models §1)", () => {
  describe("playOneShot", () => {
    it.todo("returns an AudioHandle; a bare number is the volume");
    it.todo("never throws: unknown clip, undefined options, NaN and Infinity values, a null-returning backend");
    it.todo("a refused play (backend.play returns null) gives an inert handle: playing false, reason null, stop and fade are no-ops");
    it.todo("passes volume, pitch, priority, bus, position and attenuation to the backend request, with oneShot true");
    it.todo("defaults: volume 1, pitch 1, priority 128, minDistance 1, maxDistance 100, flat without position");
    it.todo("pitch is clamped to 0.0625..16 and warns once");
    it.todo("priority is clamped to 0..255");
    it.todo("an unknown bus plays on Master and warns once (the mixer's warning)");
    it.todo("at: a finite time reaches the request; non-finite warns once and plays now (request.at undefined)");
    it.todo("at is ignored while Audio.status is locked");
    it.todo("a negative or non-finite volume is clamped and warns once");
  });
  describe("AudioHandle", () => {
    it.todo("playing is true right after playOneShot");
    it.todo("stop() ends it at once; a second stop is a no-op");
    it.todo("stop(fadeSeconds) fades then stops");
    it.todo("fade(to, seconds) eases the voice gain; to is clamped to 0..4");
    it.todo("after the voice ends or its slot is reused every call is a no-op and playing is false");
    it.todo("reason is null while audible, and 'stolen' or 'failed' after an early end");
    it.todo("a locked sound reads playing true with reason 'locked'");
  });
  describe("bus, buses, snapshot, clearSnapshot", () => {
    it.todo("bus(name) returns the mixer bus; buses lists the names");
    it.todo("snapshot and clearSnapshot default to a 0.5 s fade");
  });
  describe("volume, masterVolume, muted", () => {
    it.todo("volume and masterVolume are the same property");
    it.todo("masterVolume is clamped 0..1 by the backend");
    it.todo("muted is readable and reads back what was set");
  });
  describe("time, status, debug", () => {
    it.todo("time is 0 before the context runs and does not move with Time.scale");
    it.todo("status reflects the backend: locked, running, failed");
    it.todo("debug() returns a copy: mutating it changes nothing, and two calls give different objects");
    it.todo("debug() delegates to backend.debug()");
    it.todo("the default backend gives status running, handle reason null and a debug with an empty voice list");
  });
  describe("Bus.peak", () => {
    it.todo("is declared and returns 0 (until A2.3), also for an unknown bus");
    it.todo("Bus.activeVoices still counts every live voice on the bus");
  });
  describe("AudioSource", () => {
    it.todo("isPlaying keeps its meaning");
    it.todo("priority defaults to 128 and an old scene without it loads as 128");
  });
  describe("exports from src/myco.ts", () => {
    it.todo("Audio, AudioSource, AudioListener are exported");
    it.todo("the public types compile: AudioHandle, AudioStatus, AudioReason, AudioDebugInfo, OneShotOptions, Rolloff, Bus");
  });
});
