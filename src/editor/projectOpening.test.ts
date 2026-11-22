// ADR 0318: one module turns a start-screen intent into an outcome (opened, cancelled, refused with a reason), over
// a fake file system; the window's last step (open here, or hand off) is a seam.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsaFileSystem, type FsaDirectoryHandle } from "./fsaFileSystem";
import { MemoryDirectoryHandle } from "./fsaMemory";
import { MemoryFileSystem } from "./memoryFs";
import { NO_FOLDERS_NOTE } from "./projectFs";
import { joinPath } from "./projectPaths";
import { projectOpening, type OpeningSeams, type OpenResult, type ProjectSource } from "./projectOpening";
import { RecentProjects, type HandleStore } from "./recentProjectList";
import type { SampleInfo } from "./samples";

/** A folder file system whose folder dialog answers from `picks` (null: cancelled; an Error: the dialog failed). */
class PickingFs extends MemoryFileSystem {
  readonly picks: (string | null | Error)[] = [];
  readonly dialogs: { title?: string; start?: string }[] = [];
  override async pickFolder(title?: string, start?: string) {
    this.dialogs.push({ title, start });
    const next = this.picks.shift() ?? null;
    if (next instanceof Error) throw next;
    return next;
  }
}

const project = (fs: MemoryFileSystem, root: string) => fs.writeText(joinPath(root, "project.json"), "{}");

function recentList() {
  let text: string | null = null;
  const handles = new Map<string, FsaDirectoryHandle>();
  const store: HandleStore = { get: async (id) => handles.get(id), set: async (id, h) => void handles.set(id, h), delete: async (id) => void handles.delete(id) };
  return new RecentProjects({ read: () => text, write: (t) => void (text = t) }, store);
}

/** The seams, recording what was opened and what progress was shown; `result` is what the window's last step answers. */
function seams(fs: MemoryFileSystem | FsaFileSystem | null, options: { confirm?: boolean; result?: (source: ProjectSource) => OpenResult } = {}) {
  const opened: ProjectSource[] = [];
  const progress: string[] = [];
  const recent = recentList();
  const s: OpeningSeams = {
    folders: async () => fs,
    recent,
    progress: (text) => void progress.push(text),
    confirm: async () => options.confirm ?? true,
    async open(source) {
      opened.push(source);
      return options.result?.(source) ?? { kind: "opened", name: "Space Game" };
    },
  };
  return { s, opened, progress, recent, opening: projectOpening(s) };
}

const flappy: SampleInfo = { id: "flappy", name: "Flappy", files: [{ path: "project.json", size: 2 }, { path: "scenes/main.scene.json", size: 2 }] };

describe("opening a project folder", () => {
  it("is refused where folders can't be opened, and cancelled before any dialog when the user says no", async () => {
    expect(await seams(null).opening.open({ kind: "pick-folder" })).toEqual({ kind: "refused", reason: { kind: "info", text: NO_FOLDERS_NOTE } });
    const fs = new PickingFs();
    expect(await seams(fs, { confirm: false }).opening.open({ kind: "pick-folder" })).toEqual({ kind: "cancelled" });
    expect(fs.dialogs).toEqual([]);
  });

  it("opens the folder picked, saying so, or is cancelled with the dialog", async () => {
    const fs = new PickingFs();
    const { opening, opened, progress } = seams(fs);
    expect(await opening.open({ kind: "pick-folder" })).toEqual({ kind: "cancelled" });
    fs.picks.push("C:\\Games\\space");
    expect(await opening.open({ kind: "pick-folder" })).toEqual({ kind: "opened", note: "Opened Space Game" });
    expect(opened).toEqual([{ kind: "folder", fs, root: "C:\\Games\\space" }]);
    expect(progress).toEqual(["Opening C:\\Games\\space…"]);
  });

  it("words a failure once: the dialog's, the window's when it throws, and the window's own refusal as it is", async () => {
    const fs = new PickingFs();
    fs.picks.push(new Error("dialog crashed"));
    expect(await seams(fs).opening.open({ kind: "pick-folder" })).toMatchObject({ kind: "refused", reason: { kind: "error", text: "dialog crashed" } });
    fs.picks.push("/g");
    const throwing = seams(fs, {
      result: () => {
        throw new Error("no project.json");
      },
    });
    expect(await throwing.opening.open({ kind: "pick-folder" })).toMatchObject({ kind: "refused", reason: { kind: "error", text: "Couldn't open /g: no project.json" } });
    fs.picks.push("/g");
    const reason = { kind: "error", text: "Couldn't open /g: it's locked" } as const;
    expect(await seams(fs, { result: () => ({ kind: "refused", reason }) }).opening.open({ kind: "pick-folder" })).toEqual({ kind: "refused", reason });
  });

  it("leaves the status line to a problem the window already reported (a main scene that didn't load)", async () => {
    const fs = new PickingFs();
    fs.picks.push("/g");
    const { opening } = seams(fs, { result: () => ({ kind: "opened", name: "Space Game", problem: true }) });
    expect(await opening.open({ kind: "pick-folder" })).toEqual({ kind: "opened", note: null });
  });
});

describe("reopening a recent project", () => {
  it("opens a desktop folder that is still there without asking", async () => {
    const fs = new PickingFs();
    await project(fs, "C:\\Games\\space");
    const { opening, opened, recent } = seams(fs);
    const entry = await recent.add({ name: "Space", path: "C:\\Games\\space" });
    expect(await opening.open({ kind: "recent", entry })).toEqual({ kind: "opened", note: "Opened Space Game" });
    expect(opened).toEqual([{ kind: "folder", fs, root: "C:\\Games\\space" }]);
    expect(fs.dialogs).toEqual([]);
  });

  it("asks for a folder it can't reach again, starting there; cancelling opens nothing", async () => {
    const fs = new PickingFs();
    const { opening, opened, recent } = seams(fs);
    const entry = await recent.add({ name: "Space", path: "C:\\Games\\space" });
    expect(await opening.open({ kind: "recent", entry })).toEqual({ kind: "cancelled" });
    expect(fs.dialogs).toEqual([{ title: "Open Space (confirm its folder)", start: "C:\\Games\\space" }]);
    fs.picks.push("D:\\space");
    expect(await opening.open({ kind: "recent", entry })).toMatchObject({ kind: "opened" });
    expect(opened).toEqual([{ kind: "folder", fs, root: "D:\\space" }]);
  });

  it("asks a browser for access to a stored folder handle and opens it as a path", async () => {
    const fs = new FsaFileSystem(null);
    const handle = new MemoryDirectoryHandle("space");
    await handle.getFileHandle("project.json", { create: true });
    const { opening, opened, recent } = seams(fs);
    const entry = await recent.add({ name: "Space", path: "space", handle });
    expect(await opening.open({ kind: "recent", entry })).toMatchObject({ kind: "opened" });
    expect(opened).toEqual([{ kind: "folder", fs, root: "/space" }]);

    handle.permission = "prompt";
    handle.grant = "denied";
    expect(await opening.open({ kind: "recent", entry })).toEqual({ kind: "refused", reason: { kind: "info", text: "Space wasn't opened: the browser wasn't given access to its folder." } });
  });

  it("is refused when the folder handle is gone, or the file system can't take one", async () => {
    const { opening, recent } = seams(new FsaFileSystem(null));
    const entry = await recent.add({ name: "Space", path: "space", handle: new MemoryDirectoryHandle("space") });
    const gone = { ...entry, id: "forgotten" };
    const refusal = { kind: "refused", reason: { kind: "error", text: "Couldn't open Space: The editor no longer has access to Space. Open its folder again with Open Project…." } };
    expect(await opening.open({ kind: "recent", entry: gone })).toMatchObject(refusal);
    const desktop = seams(new PickingFs());
    expect(await desktop.opening.open({ kind: "recent", entry })).toMatchObject(refusal);
  });
});

describe("samples and new projects", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { baseURI: "http://editor.test/" });
    vi.stubGlobal("fetch", async (url: string) => new Response(`{"from":"${new URL(url).pathname}"}`));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens a sample read-only, asking first", async () => {
    const { opening, opened } = seams(null);
    expect(await opening.open({ kind: "sample", sample: flappy })).toEqual({ kind: "opened", note: "Opened the Flappy sample (read-only). Make a copy to edit it." });
    expect(opened).toEqual([{ kind: "sample", sample: flappy }]);
    expect(await seams(null, { confirm: false }).opening.open({ kind: "sample", sample: flappy })).toEqual({ kind: "cancelled" });
  });

  it("copies a sample into the folder picked and opens the copy; a folder that holds a project is refused", async () => {
    const fs = new PickingFs();
    fs.picks.push("/copy");
    const { opening, opened, progress } = seams(fs);
    expect(await opening.open({ kind: "copy-sample", sample: flappy })).toEqual({ kind: "opened", note: "Copied Flappy to /copy." });
    expect(await fs.readText(joinPath("/copy", "scenes/main.scene.json"))).toBe('{"from":"/samples/flappy/scenes/main.scene.json"}');
    expect(opened).toEqual([{ kind: "folder", fs, root: "/copy" }]);
    expect(progress).toEqual(["Copying Flappy to /copy…", "Opening /copy…"]);
    fs.picks.push("/copy");
    expect(await opening.open({ kind: "copy-sample", sample: flappy })).toMatchObject({ kind: "refused", reason: { kind: "error", text: `Couldn't copy Flappy: "/copy" already holds a project; choose an empty folder.` } });
  });

  it("creates a project in its own folder and opens it; one that can't be created is refused", async () => {
    const fs = new PickingFs();
    const { opening, opened } = seams(fs);
    const intent = { kind: "new", fs, parent: "/games", name: " Space Game ", template: "2d" } as const;
    expect(await opening.open(intent)).toEqual({ kind: "opened", note: "Created Space Game in " + joinPath("/games", "Space Game") + "." });
    expect(await fs.exists(joinPath(joinPath("/games", "Space Game"), "project.json"))).toBe(true);
    expect(opened).toEqual([{ kind: "folder", fs, root: joinPath("/games", "Space Game") }]);
    expect(await opening.open(intent)).toMatchObject({ kind: "refused", reason: { kind: "error", text: expect.stringMatching(/^Couldn't create Space Game: .*isn't empty/) } });
  });

  it("opens a project another window resolved without asking", async () => {
    const fs = new PickingFs();
    const { opening, opened } = seams(fs, { confirm: false });
    expect(await opening.openResolved({ kind: "folder", fs, root: "/g" })).toEqual({ kind: "opened", note: "Opened Space Game" });
    expect(await opening.openResolved({ kind: "sample", sample: flappy })).toMatchObject({ kind: "opened" });
    expect(opened.map((s) => s.kind)).toEqual(["folder", "sample"]);
  });
});

describe("choosing where a new project goes", () => {
  it("answers the folder chosen, cancelled, or why not", async () => {
    const fs = new PickingFs();
    const { opening } = seams(fs);
    expect(await opening.pickLocation()).toEqual({ kind: "cancelled" });
    fs.picks.push("/games");
    expect(await opening.pickLocation()).toEqual({ kind: "chosen", fs, path: "/games" });
    fs.picks.push(new Error("denied"));
    expect(await opening.pickLocation()).toMatchObject({ kind: "refused", reason: { kind: "error", text: "Couldn't choose a folder: denied" } });
    expect(await seams(null).opening.pickLocation()).toEqual({ kind: "refused", reason: { kind: "info", text: NO_FOLDERS_NOTE } });
  });
});
