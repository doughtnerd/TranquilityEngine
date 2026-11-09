import { describe, it } from "vitest";

// A0.3-L3 fills these (architecture §3.1), with a plain `EventTarget` for the page and a fake context.
describe("Unlock", () => {
  it.todo("arm attaches pointerdown and keydown on the target, capture and passive, and statechange on the context");
  it.todo("arm does nothing when the context is already running");
  it.todo("arm twice attaches once");
  it.todo("a gesture calls resume synchronously inside the event");
  it.todo("statechange to running disarms and calls onUnlocked once");
  it.todo("a resume that resolves with state running also disarms and calls onUnlocked once");
  it.todo("a rejected resume stays armed, raises no unhandled rejection, and the next gesture retries");
  it.todo("statechange to anything but running keeps it armed");
  it.todo("disarm removes every listener; gestures after it don't resume");
  it.todo("dispose disarms and later arm calls do nothing");
});
