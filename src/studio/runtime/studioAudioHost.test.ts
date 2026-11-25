// The Studio's audio runtime host, through its interface, over a fake starter and a fake public `Audio`.
import { describe, expect, it, vi } from "vitest";
import { statsFromDebug } from "./audioStats";
import { CORE_UNAVAILABLE, PREVIEW_HANDOFF_FADE, coreUnavailableText, createStudioAudioHost, studioRuntimeSettings, type AudioApi, type HostSeams } from "./studioAudioHost";

/** A fake `Audio`: its debug answers with `backend` and `status`; plays give handles that stay playing until stopped. */
function fakeAudio(over: { backend?: string; status?: string; throws?: boolean; why?: string } = {}) {
  const state = { backend: over.backend ?? "core", status: over.status ?? "running" };
  const handles: { stopped: number | null; playing: boolean; stop(f?: number): void }[] = [];
  const handle = (playing = true) => {
    const h = { stopped: null as number | null, playing, stop(f = 0) { h.stopped = f; h.playing = false; } };
    handles.push(h);
    return h;
  };
  const audio = {
    debug: () => {
      if (over.throws) throw new Error("gone");
      return { status: state.status, sampleRate: 48000, counters: { mixedVoices: 2, mixedCap: 64, underruns: 0 }, core: { backend: state.backend }, cpu: { loadPermille: 42, hidden: null }, ...(over.why ? { coreUnavailable: over.why } : {}) };
    },
    get status() {
      return state.status;
    },
    latency: { base: 0.01, output: 0.01, limiter: 0.003, total: 0.023, reliable: true },
    play: vi.fn(() => handle()),
    playOneShot: vi.fn(() => handle()),
  } as unknown as AudioApi;
  return { audio, state, handles };
}

/** A fake `Audio` with a clock and handles that fade, for spans. */
function spanAudio() {
  const base = fakeAudio();
  const clock = { t: 0 };
  const calls: { at?: number; offset?: number }[] = [];
  const handles: { gain: number; playing: boolean; stop(f?: number): void; fade(to: number, s: number): void }[] = [];
  const audio = Object.assign({}, base.audio, {
    playOneShot: vi.fn((_path: string, o: { at?: number; offset?: number }) => {
      const r = (x: number) => Math.round(x * 1e6) / 1e6;
      calls.push({ at: o.at === undefined ? undefined : r(o.at), ...(o.offset !== undefined ? { offset: r(o.offset) } : {}) });
      const h = { gain: 1, playing: true, stop() { h.playing = false; }, fade(to: number) { h.gain = to; } };
      handles.push(h);
      return h;
    }),
  }) as AudioApi;
  Object.defineProperty(audio, "status", { get: () => "running" });
  Object.defineProperty(audio, "time", { get: () => clock.t });
  return { audio, clock, calls, handles };
}

type Start = (settings: unknown) => Promise<{ stop(): void }>;
function seams(audio: AudioApi, start: ReturnType<typeof vi.fn<Start>> = vi.fn<Start>(async () => ({ stop: vi.fn() }))) {
  const ticks: (() => void)[] = [];
  const s: HostSeams = { audio, starter: { start }, every: (_ms, fn) => (ticks.push(fn), () => ticks.splice(ticks.indexOf(fn), 1)) };
  return { s, start, tick: () => ticks.forEach((t) => t()), polling: () => ticks.length };
}

describe("Studio audio runtime host", () => {
  it("forces the Rust core backend whatever the project says, and drops autoloads", () => {
    expect(studioRuntimeSettings({ name: "Racer", audio: { backend: "babylon", voices: { max: 8 } } as never, autoload: ["x"] as never })).toEqual({ name: "Racer", autoload: [], audio: { backend: "core", voices: { max: 8 } } });
    expect(studioRuntimeSettings({}).audio).toEqual({ backend: "core" });
  });

  it("starts the runtime with the forced settings and runs once the core answers", async () => {
    const { audio } = fakeAudio();
    const { s, start } = seams(audio);
    const host = createStudioAudioHost(s);
    expect(host.state.value.kind).toBe("idle");
    await host.open({ name: "Racer", audio: { backend: "babylon" } as never });
    expect(start.mock.calls[0][0]).toMatchObject({ audio: { backend: "core" } });
    expect(host.state.value.kind).toBe("running");
    expect(host.stats.value).toMatchObject({ backend: "core", sampleRate: 48000, voices: 2, voiceCap: 64, cpuPercent: 4.2, latencyMs: 23 });
  });

  it("waits while the core loads, reports locked until a gesture, then running", async () => {
    const f = fakeAudio({ backend: "pending", status: "locked" });
    const { s, tick } = seams(f.audio);
    const host = createStudioAudioHost(s);
    await host.open({});
    expect(host.state.value.kind).toBe("starting");
    f.state.backend = "core";
    tick();
    expect(host.state.value.kind).toBe("locked");
    expect(host.playable.value).toBe(true);
    f.state.status = "running";
    tick();
    expect(host.state.value.kind).toBe("running");
  });

  it("says why and refuses to play when the engine fell back from the core", async () => {
    const { audio } = fakeAudio({ backend: "babylon" });
    const host = createStudioAudioHost(seams(audio).s);
    await host.open({});
    expect(host.state.value).toEqual({ kind: "failed", reason: CORE_UNAVAILABLE });
    expect(host.audition("music/theme.playlist.json")).toBeNull();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("shows the engine's own reason the core didn't start when it gave one", async () => {
    const why = `audio core couldn't load (WebAssembly.instantiate(): out of memory); using "babylon".`;
    const host = createStudioAudioHost(seams(fakeAudio({ backend: "babylon", why }).audio).s);
    await host.open({});
    const state = host.state.value;
    expect(state.kind).toBe("failed");
    const reason = state.kind === "failed" ? state.reason : "";
    expect(reason).toMatch(/plays only through the core/);
    expect(reason).toMatch(/The engine says: audio core couldn't load \(WebAssembly.instantiate\(\): out of memory\)$/);
    expect(coreUnavailableText("Audio core unavailable: this engine lacks AudioWorklet. The core needs X. Using the \"babylon\" backend: basic playback.")).toMatch(/lacks AudioWorklet\. The core needs X\.$/);
    expect(coreUnavailableText(undefined)).toBe(CORE_UNAVAILABLE);
  });

  it("reports a runtime that couldn't start, or a core that stopped", async () => {
    const { audio } = fakeAudio();
    const host = createStudioAudioHost(seams(audio, vi.fn<Start>(async () => Promise.reject(new Error("no WebGL")))).s);
    await host.open({});
    expect(host.state.value).toMatchObject({ kind: "failed", reason: expect.stringContaining("no WebGL") });
    const f = fakeAudio({ status: "failed" });
    const other = createStudioAudioHost(seams(f.audio).s);
    await other.open({});
    expect(other.state.value).toMatchObject({ kind: "failed", reason: expect.stringContaining("stopped") });
  });

  it("auditions through the public Audio API and stops what it started", async () => {
    const f = fakeAudio();
    const host = createStudioAudioHost(seams(f.audio).s);
    expect(host.audition("a.playlist.json")).toBeNull(); // nothing open
    await host.open({});
    const h = host.audition("a.playlist.json", { parameters: { speed: 3 } });
    host.playClip("audio/horn.wav", { volume: 0.5 });
    expect(f.audio.play).toHaveBeenCalledWith("a.playlist.json", { parameters: { speed: 3 } });
    expect(h).not.toBeNull();
    host.stopAll(0.2);
    expect(f.handles.map((x) => x.stopped)).toEqual([0.2, 0.2]);
  });

  it("previews one asset at a time: another asset stops the last, the same one layers, a layer play is left alone", async () => {
    const f = fakeAudio();
    const host = createStudioAudioHost(seams(f.audio).s);
    await host.open({});
    host.audition("fx/tremolo.playlist.json");
    host.audition("fx/tremolo.playlist.json"); // again: both play (max instances, cooldown)
    const replayed = host.audition("takes/run.instance.playlist.json", {}, "layer");
    expect(f.handles.map((h) => h.playing)).toEqual([true, true, true]);
    host.playClip("audio/horn.wav");
    expect(f.handles.map((h) => h.stopped)).toEqual([PREVIEW_HANDOFF_FADE, PREVIEW_HANDOFF_FADE, null, null]);
    expect(replayed!.playing).toBe(true);
    host.audition("music/theme.playlist.json");
    expect(f.handles[3]!.stopped).toBe(PREVIEW_HANDOFF_FADE);
    expect(f.handles[4]!.playing).toBe(true);
  });

  it("closes: stops the Engine and polling, back to idle; a close while starting stops the late Engine", async () => {
    const f = fakeAudio();
    const stop = vi.fn();
    const { s, polling } = seams(f.audio, vi.fn<Start>(async () => ({ stop })));
    const host = createStudioAudioHost(s);
    await host.open({});
    expect(polling()).toBe(1);
    host.close();
    expect(stop).toHaveBeenCalledOnce();
    expect(polling()).toBe(0);
    expect(host.state.value.kind).toBe("idle");
    let release!: () => void;
    const lateStop = vi.fn();
    const slow = createStudioAudioHost(seams(f.audio, vi.fn<Start>(() => new Promise<{ stop(): void }>((r) => (release = () => r({ stop: lateStop }))))).s);
    const opening = slow.open({});
    slow.close();
    release();
    await opening;
    expect(lateStop).toHaveBeenCalledOnce();
    expect(slow.state.value.kind).toBe("idle");
  });

  it("plays a span of a clip: started at `from` (a start offset), stopped at `to`", async () => {
    const f = spanAudio();
    const { s, tick } = seams(f.audio);
    const host = createStudioAudioHost(s);
    await host.open({});
    f.clock.t = 10;
    const p = host.playClipSpan("a.wav", { from: 1, to: 1.5 })!;
    expect(p.startedAt).toBeCloseTo(10.05, 9);
    expect(f.calls).toEqual([{ at: 10.05, offset: 1 }]);
    expect(f.handles[0].gain).toBe(1); // heard at once: no silent lead-in
    f.clock.t = 10.3;
    tick();
    expect(f.handles[0].playing).toBe(true);
    f.clock.t = 10.56;
    tick();
    expect(f.handles[0].playing).toBe(false);
    expect(p.playing).toBe(false);
    expect(host.playClipSpan("a.wav", { from: 1, to: 1 })).toBeNull();
  });

  it("cycles a loop with a pass started ahead for each seam, and releases to the tail", async () => {
    const f = spanAudio();
    const { s, tick } = seams(f.audio);
    const host = createStudioAudioHost(s);
    await host.open({});
    f.clock.t = 0;
    const p = host.playClipSpan("a.wav", { from: 0, to: 3, loop: { start: 1, end: 2, count: 0, crossfadeMs: 0 } })!;
    // Seam 0 at 0.05 + 2 = 2.05; the next pass is stamped there, 1 s into the clip (asked for 0.25 s ahead).
    f.clock.t = 1.85;
    tick();
    expect(f.calls).toEqual([{ at: 0.05 }, { at: 2.05, offset: 1 }]);
    expect(f.handles[1].gain).toBe(1);
    f.clock.t = 2.06;
    tick();
    expect(f.handles[0].playing).toBe(false);
    expect(f.handles[1].gain).toBe(1);
    p.release();
    f.clock.t = 3.04; // the pass reaches the loop's end at 3.05, then plays the tail to 3 s in the clip (4.05)
    tick();
    expect(f.handles[1].playing).toBe(true);
    f.clock.t = 4.06;
    tick();
    expect(p.playing).toBe(false);
    expect(f.calls).toHaveLength(2);
  });

  it("plays across a seam: the loop's last moment, then its first, stopping before `from` in the second pass", async () => {
    const f = spanAudio();
    const { s, tick } = seams(f.audio);
    const host = createStudioAudioHost(s);
    await host.open({});
    f.clock.t = 0;
    const p = host.playClipSpan("a.wav", { from: 1.9, to: 1.1, loop: { start: 1, end: 2, count: 2, crossfadeMs: 0 } })!;
    expect(p).not.toBeNull();
    // The seam at 0.05 + 0.1 = 0.15: the second pass starts there from the loop's start, and stops 0.1 s in (0.25).
    f.clock.t = 0.1;
    tick();
    expect(f.calls).toEqual([{ at: 0.05, offset: 1.9 }, { at: 0.15, offset: 1 }]);
    f.clock.t = 0.16;
    tick();
    expect(f.handles[0].playing).toBe(false);
    expect(f.handles[1].playing).toBe(true);
    f.clock.t = 0.26;
    tick();
    expect(p.playing).toBe(false);
    expect(f.calls).toHaveLength(2);
    // Without a loop, a span that ends before it starts is nothing to play.
    expect(host.playClipSpan("a.wav", { from: 1.9, to: 1.1 })).toBeNull();
  });

  it("crossfades a seam: the next pass starts a crossfade early, silent, and fades in", async () => {
    const f = spanAudio();
    const { s, tick } = seams(f.audio);
    const host = createStudioAudioHost(s);
    await host.open({});
    f.clock.t = 0;
    host.playClipSpan("a.wav", { from: 0.5, to: 3, loop: { start: 1, end: 2, count: 0, crossfadeMs: 100 } })!;
    // The first pass from 0.5 s: a crossfade's lead (0.1 s, clamped to now) before it is heard, silent; seam 0 at 0.05 + 1.5 = 1.55.
    expect(f.calls).toEqual([{ at: 0, offset: 0.45 }]);
    expect(f.handles[0].gain).toBe(0);
    f.clock.t = 1.3;
    tick();
    expect(f.calls[1]).toEqual({ at: 1.45, offset: 0.9 });
    expect(f.handles[1].gain).toBe(0);
    f.clock.t = 1.46;
    tick();
    expect(f.handles[1].gain).toBe(1);
  });

  it("reads stats leniently", () => {
    const s = statsFromDebug({ status: "running", sampleRate: NaN, counters: undefined as never, core: {}, cpu: { loadPermille: null, hidden: "clock too coarse" } as never }, null);
    expect(s).toMatchObject({ backend: "unknown", sampleRate: 0, voices: 0, cpuPercent: null, cpuNote: "clock too coarse", latencyMs: 0, fxStarved: 0, fxStarvedOwner: null });
    const starved = statsFromDebug({ status: "running", sampleRate: 48000, counters: undefined as never, core: {}, cpu: null as never, mix: { fxStarved: 3, fxStarvedOwner: "instance submix 2" } as never }, null);
    expect(starved).toMatchObject({ fxStarved: 3, fxStarvedOwner: "instance submix 2" });
  });
});
