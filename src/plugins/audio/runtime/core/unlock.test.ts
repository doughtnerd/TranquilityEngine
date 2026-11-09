import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Unlock, type UnlockContext } from "./unlock";

// A0.3-L3 fills these (architecture §3.1), with a plain `EventTarget` for the page and a fake context.

/** A fake context: a mutable `state`, a `vi.fn` resume, and a statechange listener set this file can fire. */
function fakeContext(state = "suspended") {
  const listeners = new Set<() => void>();
  const context = {
    state,
    resume: vi.fn((): Promise<void> => Promise.resolve()),
    addEventListener(_type: "statechange", listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: "statechange", listener: () => void) {
      listeners.delete(listener);
    },
    fireStateChange() {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
  return context;
}

type FakeContext = ReturnType<typeof fakeContext>;

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const captureOptions = { capture: true, passive: true };

describe("Unlock", () => {
  const unhandled = vi.fn();

  beforeEach(() => {
    process.on("unhandledRejection", unhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", unhandled);
    vi.restoreAllMocks();
    unhandled.mockClear();
  });

  function setup(state = "suspended") {
    const target = new EventTarget();
    const context: FakeContext = fakeContext(state);
    const onUnlocked = vi.fn();
    const unlock = new Unlock({ target, context: context as unknown as UnlockContext, onUnlocked });
    return { target, context, onUnlocked, unlock };
  }

  it("arm attaches pointerdown and keydown on the target, capture and passive, and statechange on the context", () => {
    const { target, context, unlock } = setup();
    const add = vi.spyOn(target, "addEventListener");

    unlock.arm();

    expect(unlock.armed).toBe(true);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith("pointerdown", expect.any(Function), captureOptions);
    expect(add).toHaveBeenCalledWith("keydown", expect.any(Function), captureOptions);
    expect(context.listenerCount()).toBe(1);
  });

  it("arm does nothing when the context is already running", () => {
    const { target, context, unlock } = setup("running");
    const add = vi.spyOn(target, "addEventListener");

    unlock.arm();

    expect(unlock.armed).toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(context.listenerCount()).toBe(0);
  });

  it("arm twice attaches once", () => {
    const { target, context, unlock } = setup();
    const add = vi.spyOn(target, "addEventListener");

    unlock.arm();
    unlock.arm();

    expect(add).toHaveBeenCalledTimes(2);
    expect(context.listenerCount()).toBe(1);
  });

  it("a gesture calls resume synchronously inside the event", () => {
    const { target, context, unlock } = setup();
    unlock.arm();

    target.dispatchEvent(new Event("pointerdown"));

    // No await: the call must already have happened by the time dispatchEvent returned.
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it("statechange to running disarms and calls onUnlocked once", () => {
    const { context, onUnlocked, unlock } = setup();
    unlock.arm();

    context.state = "running";
    context.fireStateChange();
    context.fireStateChange();

    expect(unlock.armed).toBe(false);
    expect(context.listenerCount()).toBe(0);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it("a resume that resolves with state running also disarms and calls onUnlocked once", async () => {
    const { target, context, onUnlocked, unlock } = setup();
    context.resume.mockImplementation(async () => {
      context.state = "running";
    });
    unlock.arm();

    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("keydown"));
    await settle();

    expect(unlock.armed).toBe(false);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it("a rejected resume stays armed, raises no unhandled rejection, and the next gesture retries", async () => {
    const { target, context, onUnlocked, unlock } = setup();
    context.resume
      .mockImplementationOnce(() => Promise.reject(new Error("blocked")))
      .mockImplementationOnce(async () => {
        context.state = "running";
      });
    unlock.arm();

    target.dispatchEvent(new Event("pointerdown"));
    await settle();

    expect(unlock.armed).toBe(true);
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();

    target.dispatchEvent(new Event("keydown"));
    await settle();

    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(unlock.armed).toBe(false);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("statechange to anything but running keeps it armed", () => {
    const { target, context, onUnlocked, unlock } = setup();
    unlock.arm();

    context.state = "suspended";
    context.fireStateChange();
    context.state = "interrupted";
    context.fireStateChange();

    expect(unlock.armed).toBe(true);
    expect(onUnlocked).not.toHaveBeenCalled();

    target.dispatchEvent(new Event("keydown"));
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it("disarm removes every listener; gestures after it don't resume", () => {
    const { target, context, unlock } = setup();
    const remove = vi.spyOn(target, "removeEventListener");
    unlock.arm();

    unlock.disarm();

    expect(unlock.armed).toBe(false);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("pointerdown", expect.any(Function), { capture: true });
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function), { capture: true });
    expect(context.listenerCount()).toBe(0);

    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("keydown"));
    expect(context.resume).not.toHaveBeenCalled();
  });

  it("dispose disarms and later arm calls do nothing", () => {
    const { target, context, unlock } = setup();
    const add = vi.spyOn(target, "addEventListener");
    unlock.arm();

    unlock.dispose();

    expect(unlock.armed).toBe(false);
    expect(context.listenerCount()).toBe(0);

    unlock.arm();

    expect(unlock.armed).toBe(false);
    expect(add).toHaveBeenCalledTimes(2);
    target.dispatchEvent(new Event("pointerdown"));
    expect(context.resume).not.toHaveBeenCalled();
  });
});
