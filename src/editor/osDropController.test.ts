// Files dropped from the OS onto the Assets panel (ADR 0085, 0324): the drop controller's three
// phases (target folder, hover state, refusal, import), and the browser and desktop adapters fed
// by fake sources in their platform's shapes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Input } from "../engine";
import { folderPath } from "./assetSelection";
import { createOsDropController, listenBrowserDrops, listenDesktopDrops, osDrag, type DesktopDragEvent, type OsDropController } from "./osDropController";
import { joinPath, openFolderProject, type EditorProject } from "./projects";
import { currentProject, status } from "./state";
import { MemoryFileSystem, ROOT, demoFolder, sampleProject } from "./testing";

let fs: MemoryFileSystem;
let project: EditorProject;
let drop: OsDropController;
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (path: string) => {
  const b = fs.files.get(joinPath(ROOT, path));
  return b === undefined ? undefined : typeof b === "string" ? b : new TextDecoder().decode(b);
};

/** An element as `closest` sees it: inside the Assets panel or not, and inside a folder element (`data-drop-folder`) or not. */
function el(o: { panel?: boolean; folder?: string } = {}): Element {
  const folderEl = o.folder === undefined ? null : { dataset: { dropFolder: o.folder } };
  return {
    closest: (sel: string) => {
      if (sel === ".asset-browser") return o.panel ? {} : null;
      if (sel === "[data-drop-folder]") return o.panel ? folderEl : null;
      return null;
    },
  } as unknown as Element;
}

const noFiles = vi.fn(async () => []);

beforeEach(async () => {
  Input.reset();
  fs = demoFolder();
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  osDrag.value = null;
  status.value = null;
  noFiles.mockClear();
  drop = createOsDropController();
});

describe("the drop controller", () => {
  it("shows the drag over the panel and the folder under the pointer, until it leaves the panel", () => {
    expect(drop.over(el())).toBe("outside");
    expect(osDrag.value).toBeNull();
    expect(drop.over(el({ panel: true, folder: "images" }))).toBe("accepted");
    expect(osDrag.value).toEqual({ folder: "images", refused: null });
    expect(drop.over(el({ panel: true }))).toBe("accepted");
    expect(osDrag.value).toEqual({ folder: null, refused: null });
    drop.left(el({ panel: true })); // into another element of the panel
    expect(osDrag.value).not.toBeNull();
    drop.left(null);
    expect(osDrag.value).toBeNull();
    drop.over(el({ panel: true }));
    drop.over(el());
    expect(osDrag.value).toBeNull();
  });

  it("imports into the folder under the pointer, else the one showing", async () => {
    const onFolder = drop.dropped(el({ panel: true, folder: "images" }), async () => [{ path: "a.txt", read: async () => bytes("A") }]);
    expect(onFolder.kind).toBe("importing");
    if (onFolder.kind !== "importing") return;
    expect((await onFolder.done).imported).toEqual(["images/a.txt"]);
    expect(text("images/a.txt")).toBe("A");

    const showing = folderPath.peek();
    const onPanel = drop.dropped(el({ panel: true }), async () => [{ path: "b.txt", read: async () => bytes("B") }]);
    expect(onPanel).toMatchObject({ kind: "importing", folder: showing });
    if (onPanel.kind === "importing") await onPanel.done;
    expect(project.files).toContain(showing ? `${showing}/b.txt` : "b.txt");
    expect(osDrag.value).toBeNull();
  });

  it("ignores a drop outside the panel", () => {
    expect(drop.dropped(el(), noFiles)).toEqual({ kind: "outside" });
    expect(noFiles).not.toHaveBeenCalled();
  });

  it("shows a read-only project's refusal while dragging and refuses the drop without reading the files", () => {
    currentProject.value = sampleProject();
    expect(drop.over(el({ panel: true, folder: "images" }))).toBe("refused");
    expect(osDrag.value?.refused).toMatch(/read-only/);
    expect(osDrag.value?.folder).toBeNull();
    expect(drop.dropped(el({ panel: true, folder: "images" }), noFiles)).toMatchObject({ kind: "refused" });
    expect(noFiles).not.toHaveBeenCalled();
    expect(status.value).toMatchObject({ kind: "error", text: expect.stringMatching(/^Can't import files: .*read-only/) });
    expect(osDrag.value).toBeNull();
  });

  it("refuses when no project is open", () => {
    currentProject.value = null;
    expect(drop.dropped(el({ panel: true }), noFiles)).toEqual({ kind: "refused", reason: "no project is open" });
  });
});

describe("the browser source", () => {
  /** A window's drag event of files at `target`, with a DataTransfer holding `files`. */
  function dragEvent(type: string, target: Element | null, o: { files?: File[]; types?: string[]; relatedTarget?: Element | null } = {}) {
    const dataTransfer = {
      types: o.types ?? ["Files"],
      dropEffect: "",
      items: (o.files ?? []).map((f) => ({ kind: "file", getAsFile: () => f })),
    };
    const e = Object.assign(new Event(type), { dataTransfer, relatedTarget: o.relatedTarget ?? null, preventDefault: vi.fn() });
    Object.defineProperty(e, "target", { value: target });
    return e;
  }

  it("claims a drag of files over the panel, with the refusal as the drop effect", () => {
    const win = new EventTarget();
    const stop = listenBrowserDrops(win as unknown as Window, drop);
    const over = dragEvent("dragover", el({ panel: true }));
    win.dispatchEvent(over);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe("copy");

    currentProject.value = sampleProject();
    const refused = dragEvent("dragover", el({ panel: true }));
    win.dispatchEvent(refused);
    expect(refused.preventDefault).toHaveBeenCalled(); // still the panel's, so the browser doesn't open the file
    expect(refused.dataTransfer.dropEffect).toBe("none");
    expect(osDrag.value?.refused).toMatch(/read-only/);

    const plain = dragEvent("dragover", el({ panel: true }), { types: ["text/plain"] });
    win.dispatchEvent(plain);
    expect(plain.preventDefault).not.toHaveBeenCalled();

    win.dispatchEvent(dragEvent("dragleave", el({ panel: true }), { relatedTarget: null }));
    expect(osDrag.value).toBeNull();
    stop();
    const after = dragEvent("dragover", el({ panel: true }));
    win.dispatchEvent(after);
    expect(after.preventDefault).not.toHaveBeenCalled();
  });

  it("imports the dropped files into the folder under the pointer", async () => {
    const win = new EventTarget();
    listenBrowserDrops(win as unknown as Window, drop);
    const e = dragEvent("drop", el({ panel: true, folder: "images" }), { files: [new File([bytes("hello")], "note.txt")] });
    win.dispatchEvent(e);
    expect(e.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(text("images/note.txt")).toBe("hello"));
  });
});

describe("the desktop source", () => {
  function fakeWebview() {
    let handler: ((event: { payload: DesktopDragEvent }) => void) | null = null;
    const unlisten = vi.fn();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    return {
      unlisten,
      start: () => started(),
      send: (payload: DesktopDragEvent) => handler!({ payload }),
      source: {
        onDragDropEvent: async (h: (event: { payload: DesktopDragEvent }) => void) => {
          handler = h;
          await ready;
          return unlisten;
        },
      },
    };
  }
  const at: { x: number; y: number }[] = [];
  /** A page at device pixel ratio 2 whose left half (CSS x < 100) is the Assets panel's "images" folder. */
  const view = {
    devicePixelRatio: 2,
    elementFromPoint: (x: number, y: number) => {
      at.push({ x, y });
      return x < 100 ? el({ panel: true, folder: "images" }) : el();
    },
  };

  it("finds the element at the physical position scaled to CSS pixels, and leaves on cancel", async () => {
    at.length = 0;
    const web = fakeWebview();
    listenDesktopDrops(web.source, view, drop);
    web.start();
    web.send({ type: "enter", paths: [], position: { x: 100, y: 60 } });
    expect(at).toEqual([{ x: 50, y: 30 }]);
    expect(osDrag.value).toEqual({ folder: "images", refused: null });
    web.send({ type: "over", position: { x: 400, y: 60 } });
    expect(osDrag.value).toBeNull();
    web.send({ type: "over", position: { x: 100, y: 60 } });
    web.send({ type: "leave" });
    expect(osDrag.value).toBeNull();
  });

  it("shows a read-only project's refusal while dragging", () => {
    currentProject.value = sampleProject();
    const web = fakeWebview();
    listenDesktopDrops(web.source, view, drop);
    web.send({ type: "over", position: { x: 10, y: 10 } });
    expect(osDrag.value?.refused).toMatch(/read-only/);
    web.send({ type: "drop", paths: ["/elsewhere/a.png"], position: { x: 10, y: 10 } });
    expect(status.value).toMatchObject({ kind: "error" });
  });

  it("imports the dropped paths, read through the project's file system", async () => {
    fs.files.set("C:\\Incoming\\pack\\a.txt", bytes("A"));
    const web = fakeWebview();
    listenDesktopDrops(web.source, view, drop);
    web.send({ type: "drop", paths: ["C:\\Incoming\\pack"], position: { x: 10, y: 10 } });
    await vi.waitFor(() => expect(text("images/pack/a.txt")).toBe("A"));
    web.send({ type: "drop", paths: ["C:\\Incoming\\pack"], position: { x: 400, y: 10 } }); // outside the panel
    await new Promise((r) => setTimeout(r, 0));
    expect(project.files).not.toContain("pack/a.txt");
  });

  it("stops listening, also when stopped before the source has started", async () => {
    const web = fakeWebview();
    const stop = listenDesktopDrops(web.source, view, drop);
    stop();
    web.start();
    await vi.waitFor(() => expect(web.unlisten).toHaveBeenCalled());
  });
});
