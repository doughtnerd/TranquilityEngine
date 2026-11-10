// A3.4b: the background controller on fakes (fake timers, a fake page, a fake host and target). The loopback file
// (`backgroundLoopback.test.ts`) runs the same modes on the real core.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioBackground } from "../backend";
import { BackgroundController, HEALTH_CHECK_MS, MUTE_RAMP_MS, PAUSE_RAMP_MS, PAUSE_SUSPEND_DELAY_MS, type BackgroundHost, type BackgroundTarget, type VisibilitySource } from "./background";
import type { DeviceSnapshot } from "./deviceChange";
import type { RebuildReason } from "./recovery";

class FakePage implements VisibilitySource {
  hidden = false;
  private readonly listeners = new Set<() => void>();
  addEventListener(_t: "visibilitychange", l: () => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: "visibilitychange", l: () => void): void {
    this.listeners.delete(l);
  }
  set(hidden: boolean): void {
    this.hidden = hidden;
    for (const l of [...this.listeners]) l();
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeTarget implements BackgroundTarget {
  backgroundMode: AudioBackground = "mute";
  statusBlocks = 0;
  hiddenFlag = false;
  readonly calls: string[] = [];
  setHidden(hidden: boolean): void {
    this.hiddenFlag = hidden;
    this.calls.push(`hidden:${hidden}`);
  }
  hiddenMute(on: boolean, rampMs: number): void {
    this.calls.push(`mute:${on}:${rampMs}`);
  }
  reanchor(): void {
    this.calls.push("reanchor");
  }
}

class FakeHost implements BackgroundHost {
  closed = false;
  status: "locked" | "running" | "failed" = "running";
  pageSuspended = false;
  state = "running";
  rate = 48_000;
  sink = "";
  deviceRate: number | null = null;
  readonly calls: string[] = [];
  private device: ((kind: "device" | "state") => void) | null = null;
  snapshot(): DeviceSnapshot {
    return { state: this.state, rate: this.rate, sink: this.sink };
  }
  async probeDeviceRate(): Promise<number | null> {
    this.calls.push("probe");
    return this.deviceRate;
  }
  onDeviceEvent(l: (kind: "device" | "state") => void): () => void {
    this.device = l;
    return () => void (this.device = null);
  }
  async suspendForBackground(): Promise<boolean> {
    this.calls.push("suspend");
    this.pageSuspended = true;
    this.state = "suspended";
    return true;
  }
  async resumeFromBackground(): Promise<boolean> {
    this.calls.push("resumeFromBackground");
    this.pageSuspended = false;
    this.state = "running";
    return true;
  }
  async resumeContext(): Promise<boolean> {
    this.calls.push("resume");
    this.state = "running";
    return true;
  }
  fire(kind: "device" | "state"): void {
    this.device?.(kind);
  }
}

function rig(mode: AudioBackground = "mute", init: (host: FakeHost) => void = () => {}) {
  const page = new FakePage();
  const host = new FakeHost();
  init(host);
  const target = new FakeTarget();
  target.backgroundMode = mode;
  const rebuilds: RebuildReason[] = [];
  const rebuild = vi.fn(async (reason: RebuildReason) => {
    rebuilds.push(reason);
    return "rebuilt" as const;
  });
  const c = new BackgroundController({ host, target, visibility: page, rebuild, now: () => performance.now() }).start();
  return { page, host, target, rebuilds, rebuild, c };
}

describe("BackgroundController: visibility (§3.8)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("mute: MASTER to 0 over 50 ms at once, ended voices freed in the STATUS handler, restored when visible", async () => {
    const { page, target, host, c } = rig("mute");
    page.set(true);
    expect(target.calls).toEqual(["hidden:true", `mute:true:${MUTE_RAMP_MS}`]);
    expect(target.hiddenFlag).toBe(true);
    expect(c.counters.backgroundEnters).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(host.calls).not.toContain("suspend");
    target.calls.length = 0;
    page.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.calls).toEqual(["hidden:false", "reanchor", `mute:false:${MUTE_RAMP_MS}`]);
    expect(host.calls).not.toContain("resumeFromBackground");
    c.dispose();
  });

  it("pause: fades 30 ms, suspends after the fade, resumes then un-fades when visible", async () => {
    const { page, target, host, c } = rig("pause");
    page.set(true);
    expect(target.calls).toEqual(["hidden:true", `mute:true:${PAUSE_RAMP_MS}`]);
    expect(host.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(PAUSE_SUSPEND_DELAY_MS);
    expect(host.calls).toEqual(["suspend"]);
    expect(host.pageSuspended).toBe(true);
    target.calls.length = 0;
    page.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.calls).toEqual(["suspend", "resumeFromBackground"]);
    expect(target.calls).toEqual(["hidden:false", "reanchor", `mute:false:${MUTE_RAMP_MS}`]);
    c.dispose();
  });

  it("pause: a tab shown again before the fade ends never suspends", async () => {
    const { page, host, c } = rig("pause");
    page.set(true);
    await vi.advanceTimersByTimeAsync(PAUSE_SUSPEND_DELAY_MS - 10);
    page.set(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(host.calls.filter((x) => x === "suspend")).toEqual([]);
    c.dispose();
  });

  it("play: nothing happens to the master or the context, but ended voices are still freed from STATUS", async () => {
    const { page, target, host, c } = rig("play");
    page.set(true);
    expect(target.calls).toEqual(["hidden:true"]);
    await vi.advanceTimersByTimeAsync(PAUSE_SUSPEND_DELAY_MS * 5);
    page.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.calls).toEqual(["hidden:true", "hidden:false", "reanchor"]);
    expect(host.calls).toEqual([]);
    c.dispose();
  });

  it("undoes what it applied even if the mode changed while hidden", async () => {
    const { page, target, c } = rig("mute");
    page.set(true);
    target.backgroundMode = "play";
    target.calls.length = 0;
    page.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.calls).toContain(`mute:false:${MUTE_RAMP_MS}`);
    c.dispose();
  });

  it("a page that starts hidden enters at once; dispose detaches", () => {
    const page = new FakePage();
    page.hidden = true;
    const target = new FakeTarget();
    const c = new BackgroundController({ host: new FakeHost(), target, visibility: page }).start();
    expect(target.calls).toEqual(["hidden:true", `mute:true:${MUTE_RAMP_MS}`]);
    c.dispose();
    expect(page.listenerCount).toBe(0);
    expect(target.hiddenFlag).toBe(false);
  });
});

describe("BackgroundController: stall, interruption, device (§3.7, §7)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rebuilds for a stall after 1 s with no STATUS while running and visible, and not before", async () => {
    const { target, rebuilds, c } = rig();
    await vi.advanceTimersByTimeAsync(900);
    expect(rebuilds).toEqual([]);
    target.statusBlocks++; // a heartbeat
    await vi.advanceTimersByTimeAsync(900);
    expect(rebuilds).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(rebuilds).toEqual(["stall"]);
    expect(c.counters.rebuildsAsked.stall).toBe(1);
    // the grace restarts after a rebuild: not again at once
    await vi.advanceTimersByTimeAsync(600);
    expect(rebuilds).toEqual(["stall"]);
    c.dispose();
  });

  it("a steady heartbeat never rebuilds", async () => {
    const { target, rebuilds, c } = rig();
    for (let i = 0; i < 40; i++) {
      target.statusBlocks++;
      await vi.advanceTimersByTimeAsync(HEALTH_CHECK_MS);
    }
    expect(rebuilds).toEqual([]);
    c.dispose();
  });

  it("a hidden page is never stalled, and gets its grace back when visible", async () => {
    const { page, rebuilds, c } = rig("play");
    page.set(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rebuilds).toEqual([]);
    page.set(false);
    await vi.advanceTimersByTimeAsync(900);
    expect(rebuilds).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(rebuilds).toEqual(["stall"]);
    c.dispose();
  });

  it("a locked host (no first STATUS yet) is not stalled", async () => {
    const { host, rebuilds, c } = rig("mute", (h) => {
      h.status = "locked";
      h.state = "suspended";
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rebuilds).toEqual([]);
    expect(host.calls).toEqual([]);
    c.dispose();
  });

  it("interrupted: counted once, resume retried, then rebuilt for the device after 2 s", async () => {
    const { host, target, rebuilds, c } = rig();
    target.statusBlocks = 1;
    host.state = "interrupted";
    host.status = "locked";
    host.resumeContext = async () => {
      host.calls.push("resume"); // the resume doesn't take
      return false;
    };
    host.fire("state");
    await vi.advanceTimersByTimeAsync(0);
    expect(c.counters.interruptions).toBe(1);
    expect(host.calls).toContain("resume");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.counters.interruptions).toBe(1);
    expect(rebuilds).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(rebuilds).toEqual(["device"]);
    c.dispose();
  });

  it("interrupted then running again before 2 s: resumed, no rebuild", async () => {
    const { host, target, rebuilds, c } = rig();
    host.state = "interrupted";
    host.fire("state");
    await vi.advanceTimersByTimeAsync(500); // the fake's resume() set it running
    for (let i = 0; i < 12; i++) {
      target.statusBlocks++;
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(host.calls).toContain("resume");
    expect(rebuilds).toEqual([]);
    c.dispose();
  });

  it("a device event at the same rate leaves it; at another rate rebuilds at the device rate", async () => {
    const { host, target, rebuilds, c } = rig();
    target.statusBlocks = 1;
    host.deviceRate = 48_000;
    host.fire("device");
    await vi.advanceTimersByTimeAsync(0);
    expect(host.calls).toContain("probe");
    expect(rebuilds).toEqual([]);
    host.deviceRate = 44_100;
    host.fire("device");
    await vi.advanceTimersByTimeAsync(0);
    expect(rebuilds).toEqual(["rate"]);
    c.dispose();
  });

  it("a state event never probes the device", async () => {
    const { host, c } = rig();
    host.fire("state");
    await vi.advanceTimersByTimeAsync(0);
    expect(host.calls).not.toContain("probe");
    c.dispose();
  });

  it("a closed context is rebuilt for the device", async () => {
    const { host, rebuilds, c } = rig();
    host.state = "closed";
    host.fire("state");
    await vi.advanceTimersByTimeAsync(0);
    expect(rebuilds).toEqual(["device"]);
    c.dispose();
  });

  it("an unrequested suspend after running is resumed once; the page's own suspend is left", async () => {
    const { host, page, c } = rig("pause");
    host.state = "suspended";
    host.fire("state");
    await vi.advanceTimersByTimeAsync(0);
    expect(host.calls.filter((x) => x === "resume")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.calls.filter((x) => x === "resume")).toHaveLength(1);
    host.calls.length = 0;
    page.set(true);
    await vi.advanceTimersByTimeAsync(PAUSE_SUSPEND_DELAY_MS);
    host.fire("state");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.calls).toEqual(["suspend"]);
    c.dispose();
  });

  it("a rebuild that throws is logged and doesn't stop the checks", async () => {
    const page = new FakePage();
    const host = new FakeHost();
    const target = new FakeTarget();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rebuild = vi.fn(async () => {
      throw new Error("boom");
    });
    const c = new BackgroundController({ host, target, visibility: page, rebuild }).start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    c.dispose();
  });
});
