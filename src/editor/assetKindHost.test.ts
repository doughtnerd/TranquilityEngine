// The asset kind host (ADR 0233): a kind declares its format, default folder and panel through a plugin's
// `registerAssetKind`; the host creates its files, gives the current value (the open document's, else the file's)
// and opens files in the kind's panel. Driven through the editor surface (`editor.assets`) and the New… menu entries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kindCreators } from "./assetKindHost";
import { kindOpens } from "./assetKindLookup";
import { editor, openAssetDocument, type AssetKindContribution } from "./sdk";
import { activatePlugin, deactivatePlugin, type EditorPlugin } from "./sdk/plugins";
import { currentProject, status } from "./state";
import { closeTestProject, openTestProject, sampleProject } from "./testing";

interface Spin {
  turns: number;
}

const spinKind: AssetKindContribution<Spin> = {
  id: "t.spin",
  extensions: [".spin.json"],
  label: "Spin",
  icon: "",
  format: {
    parse(raw) {
      if (raw === "broken") throw new Error("not a spin");
      const turns = (raw as { turns?: unknown } | undefined)?.turns;
      return typeof turns === "number" ? { value: { turns }, problems: [] } : { value: { turns: 0 }, problems: [{ message: "turns isn't a number" }] };
    },
    format: (value) => `${JSON.stringify(value)}\n`,
    empty: () => ({ turns: 1 }),
  },
  folder: "spins",
  panel: "t.spinpanel",
  create: { label: "New Spin", what: "spins" },
};

/** A kind that writes its own files (two of them), given the folder. */
const pairKind: AssetKindContribution = {
  id: "t.pair",
  extensions: [".pair.json"],
  label: "Pair",
  icon: "",
  folder: "pairs",
  create: {
    label: "New Pair",
    create: async (folder) => {
      const path = `${folder ? `${folder}/` : ""}a.pair.json`;
      await editor.project.peek()!.writeText(path, "{}");
      return path;
    },
  },
};

const plugin: EditorPlugin = {
  manifest: { name: "t.spins", version: "1" },
  activate(context) {
    context.registerAssetKind(spinKind);
    context.registerAssetKind(pairKind);
    context.registerPanel({ id: "t.spinpanel", title: "Spin", view: async () => () => null, onDemand: true });
  },
};

beforeEach(() => activatePlugin(plugin));
afterEach(() => {
  deactivatePlugin("t.spins");
  closeTestProject();
  status.value = null;
});

describe("creating files", () => {
  it("writes the format's empty value in the kind's folder when the project has it, under its New… name", async () => {
    const { project } = await openTestProject({ "spins/old.spin.json": '{ "turns": 3 }' });
    expect(await editor.assets.create("t.spin")).toBe("spins/New Spin.spin.json");
    expect(project.assets.get("spins/New Spin.spin.json")).toEqual({ turns: 1 });
    expect(status.value).toMatchObject({ kind: "info", text: "Created New Spin.spin.json." });
  });

  it("uses the project root without that folder, and a folder, value and name when given", async () => {
    const { project } = await openTestProject();
    expect(await editor.assets.create("t.spin")).toBe("New Spin.spin.json");
    expect(await editor.assets.create<Spin>("t.spin", { folder: "fx", value: { turns: 7 }, name: "Fast" })).toBe("fx/Fast.spin.json");
    expect(project.assets.get("fx/Fast.spin.json")).toEqual({ turns: 7 });
  });

  it("is the New… entry: at the project root in the kind's folder, elsewhere where the panel is", async () => {
    await openTestProject({ "spins/old.spin.json": "{}", "pairs/x.json": "{}" });
    const entry = (kind: string) => kindCreators().find((c) => c.kind === kind)!;
    expect(entry("t.spin").label).toBe("New Spin");
    expect(await entry("t.spin").create("")).toBe("spins/New Spin.spin.json");
    expect(await entry("t.spin").create("art")).toBe("art/New Spin.spin.json");
    // A kind that writes its own files gets the folder the host chose.
    expect(await entry("t.pair").create("")).toBe("pairs/a.pair.json");
  });

  it("refuses in a read-only project, naming what it would add", async () => {
    currentProject.value = sampleProject();
    expect(await editor.assets.create("t.spin")).toBeNull();
    expect(status.value?.text).toBe("Flappy sample is read-only. Open a project folder (or copy the sample) to add spins.");
  });
});

describe("the current value", () => {
  it("is the file's when no document is open, and the open document's (unwritten edits too) when one is", async () => {
    const { project } = await openTestProject({ "a.spin.json": '{ "turns": 2 }' });
    expect(editor.assets.read<Spin>(project, "a.spin.json")).toEqual({ value: { turns: 2 }, problems: [] });
    const doc = openAssetDocument<Spin>(project, "a.spin.json");
    doc.edit({ turns: 5 }, { coalesce: true }); // queued: the file still says 2
    expect(project.assets.get("a.spin.json")).toEqual({ turns: 2 });
    expect(editor.assets.read<Spin>(project, "a.spin.json").value).toEqual({ turns: 5 });
    await doc.flush();
  });

  it("reports bad values as the format does, and a file the format can't read as its empty value", async () => {
    const { project } = await openTestProject({ "a.spin.json": '{ "turns": "x" }', "b.spin.json": '"broken"' });
    expect(editor.assets.read(project, "a.spin.json")).toEqual({ value: { turns: 0 }, problems: [{ message: "turns isn't a number" }] });
    expect(editor.assets.read(project, "b.spin.json")).toEqual({ value: { turns: 1 }, problems: [{ message: "not a spin" }] });
  });
});

describe("opening in the kind's panel", () => {
  it("makes the file the panel's, for the open project only", async () => {
    await openTestProject({ "a.spin.json": "{}" });
    expect(kindOpens("a.spin.json")).toBe(true);
    expect(editor.assets.openIn("t.spinpanel")).toBeNull();
    expect(editor.assets.open("a.spin.json")).toBe(true);
    expect(editor.assets.openIn("t.spinpanel")).toBe("a.spin.json");
    await openTestProject({ "a.spin.json": "{}" }); // another project: nothing is open in the panel
    expect(editor.assets.openIn("t.spinpanel")).toBeNull();
  });

  it("doesn't open a kind with no panel, open or Code panel policy", async () => {
    await openTestProject({ "a.pair.json": "{}" });
    expect(kindOpens("a.pair.json")).toBe(false);
    expect(editor.assets.open("a.pair.json")).toBe(false);
  });
});

describe("opening in the Audio Studio (ADR 0341)", () => {
  const studioKinds: EditorPlugin = {
    manifest: { name: "t.studio", version: "1" },
    activate(context) {
      context.registerAssetKind({ id: "t.playlist", extensions: [".playlist.json"], label: "Playlist", icon: "", format: spinKind.format });
    },
  };
  beforeEach(() => activatePlugin(studioKinds));
  afterEach(() => {
    deactivatePlugin("t.studio");
    vi.unstubAllGlobals();
  });

  it("opens a file the Studio opens, whose kind has no panel of its own, on its Studio screen", async () => {
    // In the browser the Studio opens in a tab of its own (studioLaunch.ts).
    const opened = vi.fn(() => ({ focus() {} }));
    vi.stubGlobal("window", { open: opened });
    vi.stubGlobal("location", { href: "http://localhost/editor.html" });
    await openTestProject({ "music/a.playlist.json": "{}", "takes/t.sporesample": new Uint8Array(4), "a.pair.json": "{}" });
    expect(kindOpens("music/a.playlist.json")).toBe(true);
    expect(kindOpens("takes/t.sporesample")).toBe(true);
    expect(editor.assets.open("music/a.playlist.json")).toBe(true);
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(String((opened.mock.calls[0] as unknown[])[0])).toMatch(/studio\.html\?project=.*#\/playlists\/music\/a\.playlist\.json$/);
  });

  it("leaves audio clips and files the Studio doesn't open alone", async () => {
    await openTestProject({ "a.wav": new Uint8Array(4), "a.pair.json": "{}" });
    expect(kindOpens("a.wav")).toBe(false);
    expect(kindOpens("a.pair.json")).toBe(false);
  });
});
