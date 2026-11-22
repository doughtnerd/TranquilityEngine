import { describe, expect, it } from "vitest";
import type { StudioOpenRequest } from "./studioAssets";
import { linkToStudio, serveStudioOpen, StudioRefusal, StudioTimeout, type Bus } from "./studioHandoff";

/** One event bus both windows share, like Tauri's app-wide events. */
function fakeBus(): Bus & { sent: string[] } {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const sent: string[] = [];
  return {
    sent,
    async emit(event, payload) {
      sent.push(event);
      await Promise.resolve();
      for (const h of handlers.get(event) ?? []) h(payload);
    },
    async listen(event, handler) {
      const set = handlers.get(event) ?? new Set();
      handlers.set(event, set);
      set.add(handler as (p: unknown) => void);
      return () => set.delete(handler as (p: unknown) => void);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const REQUEST: StudioOpenRequest = { project: "C:/games/demo", asset: "music/town.mp3" };

describe("Audio Studio handoff", () => {
  it("waits for a Studio window created after it to load, then hands it the request", async () => {
    const bus = fakeBus();
    const link = linkToStudio(bus);
    const opened: StudioOpenRequest[] = [];
    let settled = false;
    const done = link.open(REQUEST).then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    expect(bus.sent).not.toContain("myco://studio-open");

    serveStudioOpen(bus, async (r) => void opened.push(r)); // the Studio window finishes loading
    await done;
    expect(opened).toEqual([REQUEST]);
    link.dispose();
  });

  it("an open Studio answers the link's ping", async () => {
    const bus = fakeBus();
    const opened: StudioOpenRequest[] = [];
    serveStudioOpen(bus, async (r) => void opened.push(r));
    await flush();
    const link = linkToStudio(bus);
    await link.open({ project: "/p", screen: "mixer" });
    expect(opened).toEqual([{ project: "/p", screen: "mixer" }]);
    expect(bus.sent).toContain("myco://studio-ping");
  });

  it("passes the Studio's refusal back in its words", async () => {
    const bus = fakeBus();
    serveStudioOpen(bus, async () => {
      throw new Error("That folder isn't a Myco project.");
    });
    const link = linkToStudio(bus);
    const err = await link.open(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioRefusal);
    expect((err as Error).message).toBe("That folder isn't a Myco project.");
  });

  it("gives up when no Studio answers", async () => {
    const link = linkToStudio(fakeBus(), 20);
    const err = await link.open(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioTimeout);
  });

  it("a stopped Studio no longer opens anything", async () => {
    const bus = fakeBus();
    const opened: StudioOpenRequest[] = [];
    const stop = serveStudioOpen(bus, async (r) => void opened.push(r));
    await flush();
    stop();
    await flush();
    const err = await linkToStudio(bus, 20).open(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioTimeout);
    expect(opened).toEqual([]);
  });
});
