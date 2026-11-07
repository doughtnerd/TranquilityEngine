// These tests run the FMOD adapter against a FAKE module. They check the adapter's own wiring (loading,
// bus groups, mix, voices, fallback), not that the real FMOD SDK accepts these calls: that is untested.
import { describe, expect, it, vi } from "vitest";
import { FmodBackend, useFmodBackendIfConfigured } from "../audio/fmodBackend";
import { Mixer } from "../audio/mixer";
import { defaultAudioSettings } from "../audio/settings";

function fakeFmod() {
  const log: string[] = [];
  const group = (name: string) => ({ name, addGroup: (g: { name: string }) => log.push(`${name}+${g.name}`), setVolume: (v: number) => log.push(`vol:${name}:${v}`), setMute() {} });
  const channel = { isPlaying: (o: { val?: boolean }) => ((o.val = true), 0), setVolume: (v: number) => log.push(`ch.vol:${v}`), setPitch() {}, stop: () => log.push("ch.stop"), setPaused() {}, setChannelGroup: () => log.push("ch.group") };
  const core = {
    setSoftwareFormat: () => 0,
    createChannelGroup: (n: string, o: { val?: unknown }) => ((o.val = group(n)), 0),
    getMasterChannelGroup: (o: { val?: unknown }) => ((o.val = group("core-master")), 0),
    createSound: (_u: string, _m: number, _e: unknown, o: { val?: unknown }) => ((o.val = {}), 0),
    playSound: (_s: unknown, g: { name: string } | null, _p: boolean, o: { val?: unknown }) => (log.push(`play:${g?.name}`), (o.val = channel), 0),
  };
  const system = { getCoreSystem: (o: { val?: unknown }) => ((o.val = core), 0), initialize: () => 0, loadBankFile: (p: string) => (log.push(`bank:${p}`), 0), update: () => log.push("update"), release: () => log.push("release"), setListenerAttributes() {} };
  const factory = (m: Record<string, any>) => {
    Object.assign(m, { Studio_System_Create: (o: { val?: unknown }) => ((o.val = system), 0), STUDIO_INITFLAGS: { NORMAL: 0 }, INITFLAGS: { NORMAL: 0 }, FS_createPreloadedFile: (...a: unknown[]) => log.push(`fs:${a[1]}`) });
    for (const f of m.preRun) f();
    queueMicrotask(() => m.onRuntimeInitialized());
  };
  return { log, factory };
}

describe("FMOD adapter against a fake module (UNTESTED with the real SDK)", () => {
  it("loads the SDK from the supplied path, mounts and loads banks, builds a channel group per bus", async () => {
    const { log, factory } = fakeFmod();
    const urls: string[] = [];
    const g: Record<string, unknown> = {};
    const backend = await FmodBackend.load({
      sdkPath: "/fmod/", banks: ["banks/Master.bank", "banks/Master.strings.bank"], globalObject: g,
      loadScript: async (u) => { urls.push(u); g.FMODModule = factory; },
    });
    expect(urls).toEqual(["/fmod/fmodstudio.js"]);
    expect(log).toContain("fs:Master.bank");
    expect(log).toContain("bank:/Master.strings.bank");
    const mixer = new Mixer(defaultAudioSettings());
    backend.configureBuses(mixer);
    expect(log).toContain("core-master+Master");
    expect(log).toContain("Master+Music");
    mixer.bus("Music").volume = 0.5;
    backend.applyMix(mixer.resolveAll());
    expect(log).toContain("vol:Music:0.5");
    const voice = backend.play({ path: "a.wav", url: "/a.wav", loop: false, stream: false, bus: "SFX" })!;
    expect(log).toContain("play:SFX");
    expect(mixer.bus("SFX").activeVoices).toBe(1);
    voice.stop();
    expect(mixer.bus("SFX").activeVoices).toBe(0);
    backend.update();
    expect(log).toContain("update");
  });
  it("explains a missing SDK and falls back instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = await useFmodBackendIfConfigured({ backend: "fmod", fmod: { sdkPath: "/nope", banks: [] } });
    expect(ok).toBe(false);
    expect(warn.mock.calls[0][0]).toMatch(/FMOD backend unavailable, using Howler/);
    warn.mockRestore();
  });
});
