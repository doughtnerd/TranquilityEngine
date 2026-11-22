// The Studio's audio runtime host, through its interface, over a fake starter and a fake public `Audio`.
import { describe, expect, it, vi } from "vitest";
import { statsFromDebug } from "./audioStats";
import { CORE_UNAVAILABLE, coreUnavailableText, createStudioAudioHost, studioRuntimeSettings, type AudioApi, type HostSeams } from "./studioAudioHost";

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

  it("reads stats leniently", () => {
    const s = statsFromDebug({ status: "running", sampleRate: NaN, counters: undefined as never, core: {}, cpu: { loadPermille: null, hidden: "clock too coarse" } as never }, null);
    expect(s).toMatchObject({ backend: "unknown", sampleRate: 0, voices: 0, cpuPercent: null, cpuNote: "clock too coarse", latencyMs: 0 });
  });
});
