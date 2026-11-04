import { describe, expect, it, vi } from "vitest";
import { linkToEditor, serveProjectsWindow, showProjectsWindow, type Bus, type OpenRequest } from "./handoff";

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

describe("Projects window handoff", () => {
  it("waits for the editor window to load before sending the project", async () => {
    const bus = fakeBus();
    const link = linkToEditor(bus, () => {});
    const opened: OpenRequest[] = [];
    let settled = false;
    const done = link.open({ kind: "folder", root: "C:/games/demo" }).then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    expect(bus.sent).not.toContain("myco://open-project");

    serveProjectsWindow(bus, async (r) => void opened.push(r)); // the editor finishes loading
    await done;
    expect(opened).toEqual([{ kind: "folder", root: "C:/games/demo" }]);
  });

  it("finds an editor window that loaded first", async () => {
    const bus = fakeBus();
    const open = vi.fn(async () => {});
    serveProjectsWindow(bus, open);
    await flush();
    const link = linkToEditor(bus, () => {}); // its ready message went out before this listened
    await link.open({ kind: "sample", id: "flappy" });
    expect(open).toHaveBeenCalledWith({ kind: "sample", id: "flappy" });
  });

  it("passes the editor's error back", async () => {
    const bus = fakeBus();
    serveProjectsWindow(bus, async () => {
      throw new Error("C:/games/demo has no project.json");
    });
    const link = linkToEditor(bus, () => {});
    await expect(link.open({ kind: "folder", root: "C:/games/demo" })).rejects.toThrow("no project.json");
  });

  it("tells the Projects window to show when the editor closes its project", async () => {
    const bus = fakeBus();
    const show = vi.fn();
    linkToEditor(bus, show);
    await flush();
    await showProjectsWindow(bus);
    expect(show).toHaveBeenCalledOnce();
  });
});
