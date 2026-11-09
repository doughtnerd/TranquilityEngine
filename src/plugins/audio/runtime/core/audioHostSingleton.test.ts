import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A0.8 (architecture §1: one host per page serves every Engine and World). The World service's `load` runs once per
// page only while its registration lives; a re-registered service, or a second Engine, must still get the page's
// one host. Here `load()` runs for real with the wasm fetch and Web Audio faked, and the AudioContext is counted.

vi.mock("./loader", () => ({
  loadCoreWasm: async () => ({ bytes: new ArrayBuffer(8), module: {} }),
  workletModuleUrl: async () => "processor.js",
}));

class FakeAudioContext extends EventTarget {
  static made = 0;
  state = "suspended";
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  constructor() {
    super();
    FakeAudioContext.made++;
  }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.state = "closed";
  });
}

class FakeAudioWorkletNode {
  port = { postMessage: vi.fn(), onmessage: null };
  connect = vi.fn();
  disconnect = vi.fn();
}

describe("one AudioContext per page", () => {
  beforeEach(() => {
    FakeAudioContext.made = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("document", new EventTarget());
  });

  afterEach(async () => {
    const { _resetAudioHostForTests } = await import("./context");
    await _resetAudioHostForTests();
    vi.unstubAllGlobals();
  });

  it("two load()s, even concurrent, give one host and one AudioContext", async () => {
    const { AUDIO_SERVICE } = await import("./service");
    const [a, b] = await Promise.all([AUDIO_SERVICE.load(""), AUDIO_SERVICE.load("")]);
    const c = await AUDIO_SERVICE.load("");
    expect(a.ready && b.ready && c.ready).toBe(true);
    expect(a.host).toBeDefined();
    expect(b.host).toBe(a.host);
    expect(c.host).toBe(a.host);
    expect(FakeAudioContext.made).toBe(1);
  });

  it("Worlds of two Engines' loads share that host; after it closes, the next load makes a new one", async () => {
    const { AUDIO_SERVICE } = await import("./service");
    const editor = AUDIO_SERVICE.create({} as never, await AUDIO_SERVICE.load(""));
    const play = AUDIO_SERVICE.create({} as never, await AUDIO_SERVICE.load(""));
    expect(play.core.host).toBe(editor.core.host);
    expect(editor.key).toBe(1);
    expect(play.key).toBe(2);
    AUDIO_SERVICE.dispose(play);
    expect(editor.core.host!.worldCount).toBe(1);
    expect(FakeAudioContext.made).toBe(1);
    await editor.core.host!.close();
    const next = await AUDIO_SERVICE.load("");
    expect(next.host).not.toBe(editor.core.host);
    expect(FakeAudioContext.made).toBe(2);
  });
});
