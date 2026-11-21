// The Projects window's start actions (ADR 0059, 0318): what the user asked for is resolved here over a fake file
// system, then handed to the editor window over the real hand-off; the outcome shows in this window's status line.
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../memoryFs";
import { NO_FOLDERS_NOTE } from "../projectFs";
import { RecentProjects } from "../recentProjectList";
import { status } from "../state";
import { launcherActions } from "./actions";
import { linkToEditor, serveProjectsWindow, type Bus, type OpenRequest } from "./handoff";

/** One event bus both windows share, like Tauri's app-wide events. */
function fakeBus(): Bus {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  return {
    async emit(event, payload) {
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

class PickingFs extends MemoryFileSystem {
  readonly picks: (string | null)[] = [];
  override async pickFolder() {
    return this.picks.shift() ?? null;
  }
}

/** The Projects window and an editor window that opens with `editor` (throwing to refuse, as the editor window does). */
function windows(editor: (request: OpenRequest) => Promise<void>, fs: PickingFs | null = new PickingFs()) {
  const bus = fakeBus();
  serveProjectsWindow(bus, editor);
  let hidden = 0;
  let text: string | null = null;
  const recent = new RecentProjects({ read: () => text, write: (t) => void (text = t) }, null);
  const actions = launcherActions({ link: linkToEditor(bus, () => {}), opened: () => void hidden++, folders: async () => fs, recent });
  return { actions, hidden: () => hidden, recent };
}

afterEach(() => (status.value = null));

describe("the Projects window's start actions", () => {
  it("hands the folder picked to the editor window, then hides with a clear status line", async () => {
    const fs = new PickingFs();
    const asked: OpenRequest[] = [];
    const w = windows(async (r) => void asked.push(r), fs);
    fs.picks.push("C:\\Games\\space");
    expect(await w.actions.open({ kind: "pick-folder" })).toEqual({ kind: "opened", note: "Opened C:\\Games\\space" });
    expect(asked).toEqual([{ kind: "folder", root: "C:\\Games\\space" }]);
    expect(w.hidden()).toBe(1);
    expect(status.value).toBeNull();
  });

  it("hands a sample over by id", async () => {
    const asked: OpenRequest[] = [];
    const w = windows(async (r) => void asked.push(r));
    await w.actions.open({ kind: "sample", sample: { id: "flappy", name: "Flappy", files: [] } });
    expect(asked).toEqual([{ kind: "sample", id: "flappy" }]);
  });

  it("shows the editor window's refusal in its own words, once, and stays", async () => {
    const fs = new PickingFs();
    const w = windows(async () => {
      throw new Error("Couldn't open C:\\Games\\space: there's no project.json");
    }, fs);
    fs.picks.push("C:\\Games\\space");
    const outcome = await w.actions.open({ kind: "pick-folder" });
    expect(outcome).toEqual({ kind: "refused", reason: { kind: "error", text: "Couldn't open C:\\Games\\space: there's no project.json" } });
    expect(status.value).toEqual({ kind: "error", text: "Couldn't open C:\\Games\\space: there's no project.json" });
    expect(w.hidden()).toBe(0);
  });

  it("confirms a recent folder it can't reach, and says so where folders can't be opened", async () => {
    const fs = new PickingFs();
    const asked: OpenRequest[] = [];
    const w = windows(async (r) => void asked.push(r), fs);
    const entry = await w.recent.add({ name: "Space", path: "C:\\Games\\space" });
    expect(await w.actions.open({ kind: "recent", entry })).toEqual({ kind: "cancelled" });
    fs.picks.push("D:\\space");
    await w.actions.open({ kind: "recent", entry });
    expect(asked).toEqual([{ kind: "folder", root: "D:\\space" }]);

    const none = windows(async () => {}, null);
    expect(await none.actions.open({ kind: "pick-folder" })).toMatchObject({ kind: "refused" });
    expect(status.value).toEqual({ kind: "info", text: NO_FOLDERS_NOTE });
    expect(await none.actions.pickProjectLocation()).toMatchObject({ kind: "refused" });
  });
});
