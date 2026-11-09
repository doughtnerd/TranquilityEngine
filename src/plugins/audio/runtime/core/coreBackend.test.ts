// A1.4 (lead): `CoreBackend` against a fake ClipRegistry and a fake link (no wasm), plus the loopback check.
import { describe, it } from "vitest";

describe("CoreBackend (api-and-models §3, §6)", () => {
  it.todo("play allocates a voice, sends PLAY with the registry's clip id, and counts the bus with mixer.voiceStarted");
  it.todo("a play on a clip that isn't ready is waitingForData and starts when the registry says resident");
  it.todo("a failed clip frees the voice with reason failed");
  it.todo("stop and fade go out through table.drainCommands as STOP and FADE");
  it.todo("an ended voice (STATUS) is freed on the next update and mixer.voiceEnded runs once");
  it.todo("onBusRemap sends BUS_CONFIG and resets the table's bus limits to the new tree's maxVoices");
  it.todo("onIdle sends RESET 0");
  it.todo("applyMix sends BUS_MIX; masterVolume and muted send MASTER");
  it.todo("update flushes one BATCH at clockMap.nextFirstFrame()");
  it.todo("spatial play sends the listener-space direction and the distance gain");
});

describe("CoreBackend on the loopback host (A1.7's createLoopbackHost)", () => {
  it.todo("plays a WAV: the rendered output carries the clip's samples (skipped until createLoopbackHost works)");
});
