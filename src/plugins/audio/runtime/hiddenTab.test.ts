// ADR 0179: the hidden-tab policy both backends share (`hiddenTab.ts`): the mode read at the hide and remembered, `pause`'s
// delayed suspend and its cancellation, and `show` returning what the hide applied.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioBackground } from "./backend";
import { HiddenTabPolicy, MUTE_RAMP_MS, PAUSE_RAMP_MS, PAUSE_SUSPEND_DELAY_MS } from "./hiddenTab";

function rig(initial: AudioBackground) {
  const calls: string[] = [];
  const state = { mode: initial };
  const policy = new HiddenTabPolicy({
    mode: () => state.mode,
    mute: (rampMs, mode) => calls.push(`mute:${rampMs}:${mode}`),
    suspend: () => calls.push("suspend"),
  });
  return { calls, state, policy };
}

describe("HiddenTabPolicy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("mute mutes over MUTE_RAMP_MS and never suspends; play does nothing", () => {
    const m = rig("mute");
    expect(m.policy.hide()).toBe("mute");
    vi.advanceTimersByTime(PAUSE_SUSPEND_DELAY_MS * 2);
    expect(m.calls).toEqual([`mute:${MUTE_RAMP_MS}:mute`]);
    const p = rig("play");
    expect(p.policy.hide()).toBe("play");
    vi.advanceTimersByTime(PAUSE_SUSPEND_DELAY_MS * 2);
    expect(p.calls).toEqual([]);
  });

  it("pause mutes over PAUSE_RAMP_MS, then suspends once the delay has passed", () => {
    const r = rig("pause");
    r.policy.hide();
    expect(r.calls).toEqual([`mute:${PAUSE_RAMP_MS}:pause`]);
    vi.advanceTimersByTime(PAUSE_SUSPEND_DELAY_MS - 1);
    expect(r.calls).not.toContain("suspend");
    vi.advanceTimersByTime(1);
    expect(r.calls).toEqual([`mute:${PAUSE_RAMP_MS}:pause`, "suspend"]);
  });

  it("a show before the delay cancels the suspend and returns the mode the hide applied, even after a setting change", () => {
    const r = rig("pause");
    r.policy.hide();
    r.state.mode = "play";
    expect(r.policy.show()).toBe("pause");
    vi.advanceTimersByTime(PAUSE_SUSPEND_DELAY_MS * 2);
    expect(r.calls).not.toContain("suspend");
    expect(r.policy.applied).toBeNull();
  });

  it("a second hide does nothing until a show; a show with no hide returns null; dispose cancels a waiting suspend", () => {
    const r = rig("pause");
    expect(r.policy.show()).toBeNull();
    r.policy.hide();
    expect(r.policy.hide()).toBeNull();
    expect(r.calls).toHaveLength(1);
    r.policy.dispose();
    vi.advanceTimersByTime(PAUSE_SUSPEND_DELAY_MS * 2);
    expect(r.calls).not.toContain("suspend");
  });
});
