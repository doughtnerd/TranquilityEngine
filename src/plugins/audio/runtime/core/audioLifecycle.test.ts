import { describe, it } from "vitest";

// A0.8-L1 fills these (architecture §1, §3.9; api-and-models §3 "Bus state serialisation", §7): the page's one
// AudioHost across play, stop and replay cycles of two Engines, with fakes for Web Audio. Hosts are built with
// `AudioHost._create(parts)` and the page singleton with `acquireAudioHost`; `_resetAudioHostForTests` in afterEach.

describe("busRemap", () => {
  it.todo("maps each old index to the index of the same name in the new tree");
  it.todo("maps names missing from the new tree to the root (0)");
  it.todo("gives an empty map from an empty tree");
});

describe("page singleton", () => {
  it.todo("two acquires, even concurrent, call start once and give the same host");
  it.todo("a failed start isn't kept: the next acquire starts again");
  it.todo("a closed host isn't kept: the next acquire starts a new one");
  it.todo("currentAudioHost is null before, the host after, null after _resetAudioHostForTests");
});

describe("World shares", () => {
  it.todo("attachWorld gives keys from 1, lowest free first; the same owner gets its existing share");
  it.todo("releaseWorld runs onWorldReleased, frees the key for reuse, and returns false for an unknown key");
  it.todo("onIdle runs once when the last World releases, not before");
  it.todo("the 256th World throws; attachWorld after close throws");
  it.todo("close runs onClose, drops every share without onWorldReleased, and a second close does nothing");
  it.todo("the context is never closed by releaseWorld (the core stays for the page)");
});

describe("AudioWorldService", () => {
  it.todo("create attaches the World and dispose releases it; a second dispose does nothing");
  it.todo("without a host (core didn't load) it holds no share and key is 0");
});

describe("reconfigure", () => {
  it.todo("the first reconfigure sets busNames and bumps busEpoch with an empty map");
  it.todo("different bus names bump busEpoch and give onBusRemap the remap; the same names return null");
  it.todo("a stand-in voice table's bus indices remap by name through onBusRemap, unknown names to the root");
  it.todo("a preset change sets pendingPreset and leaves preset alone; the same preset clears it");
});

describe("two Engines on one page (§3.9)", () => {
  it.todo("connectHostToEngines applies the mixer's settings, then follows each Engine.create's audio settings");
  it.todo("connecting the same host twice adds one listener; the disconnect, or close, stops following");
  it.todo("play, stop and replay cycles across an editor World and play Worlds keep one host and one context");
  it.todo("on the \"babylon\" backend no host starts and Engine.create behaves as before");
});
