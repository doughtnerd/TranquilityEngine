// Editing UI documents from the editor (ADR 0077 wave B, part 2): Inspector writes, text content,
// ids and classes, Move to class, Create, hierarchy edits, undo in the scene's history, and
// read-only projects refusing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Color, Engine, GameObject, Input } from "../engine";
import { UIButton, UIPanel, UIText } from "../engine/ui/components";
import { UIDocument } from "../engine/ui/UIDocument";
import { loadUIDocumentSupport } from "../engine/ui/UIDocument";
import { MemoryFileSystem } from "./memoryFs";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, readOnlyProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, playState, sceneCamera, select, status } from "./state";
import { editorTextFiles } from "./textFiles";
import {
  beginUIEdit,
  createUIDocument,
  createUIElement,
  cssValue,
  deleteUIElement,
  duplicateUIElement,
  endUIEdit,
  moveUIElement,
  moveUIElementToClass,
  renameUIElement,
  setUIElementAttributes,
  setUIElementClasses,
  setUIElementField,
  setUIElementText,
  whyNotMovable,
} from "./uiDocumentEdits";
import { fieldSources, resolveUIElement, selectedUIRef, selectUIElement, type UIElementRef } from "./uiDocuments";
import { getFields } from "../engine/core/registry";

const ROOT = "C:\\Games\\ui";
const DT = 1 / 60;

const MENU = `<!-- The menu -->
<Canvas>
  <Style src="menu.ui.css"/>
  <Panel id="menu" class="column" padding="12">
    <Text id="title">Score: {score}</Text>
    <Text class="note" color="#ff0000" font-size="20">Plain</Text>
    <Button id="play" class="primary">Play</Button>
    <Use src="widgets/badge.ui.xml" id="badge"/>
  </Panel>
</Canvas>
`;
const MENU_CSS = `:root { --fg: #ffeedd; }
.column { flex-direction: column; color: var(--fg); }
.primary { background-color: #336699; }
#title { font-size: 30px; }
`;
const BADGE = `<Panel class="badge" gap="3">
  <Text>Badge</Text>
</Panel>
`;
const BARE = `<Canvas>\n  <Panel id="box" padding="8" background-color="rgb(255, 0, 0)" width="50"/>\n</Canvas>\n`;

const SCENE = {
  format: "myco.scene@1",
  nodes: [
    { id: "cam", name: "Camera", components: [{ type: "engine.Transform" }, { type: "engine.Camera" }] },
    { id: "hud", name: "HUD", components: [{ type: "engine.Transform" }, { type: "engine.UIDocument", data: { document: "asset:ui/menu.ui.xml" } }] },
    { id: "bare", name: "Bare", components: [{ type: "engine.Transform" }, { type: "engine.UIDocument", data: { document: "asset:ui/bare.ui.xml" } }] },
  ],
};

let engine: Engine;
let project: EditorProject;

async function open(p: EditorProject): Promise<void> {
  project = p;
  useProjectAssets(project);
  currentProject.value = project;
  await loadUIDocumentSupport();
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
}

const FILES: Record<string, string> = {
  "project.json": JSON.stringify({ name: "UI test" }),
  "scenes/main.scene.json": JSON.stringify(SCENE, null, 2),
  "ui/menu.ui.xml": MENU,
  "ui/menu.ui.css": MENU_CSS,
  "ui/widgets/badge.ui.xml": BADGE,
  "ui/bare.ui.xml": BARE,
};

beforeEach(async () => {
  Input.reset();
  status.value = null;
  const fs = new MemoryFileSystem();
  for (const [path, text] of Object.entries(FILES)) fs.files.set(joinPath(ROOT, path), text);
  await open(await openFolderProject(fs, ROOT));
});

afterEach(async () => {
  await editorTextFiles.flush();
  select([]);
  playState.value = "edit";
  openScene.value?.sync.dispose();
  openScene.value = null;
  currentProject.value = null;
  engine.dispose();
  vi.restoreAllMocks();
});

const scene = () => openScene.value!;
const ref = (path: string, host = "hud"): UIElementRef => ({ host, index: 0, path });
const el = (path: string, host = "hud") => resolveUIElement(scene().sync, ref(path, host));
const text = (path: string) => project.textOf(path)!;
/** Let queued file writes land and the Editor World rebuild the documents. */
async function settle(): Promise<void> {
  await editorTextFiles.flush();
  engine.step(DT);
}
async function undo(): Promise<void> {
  expect(scene().stack.undo()).toBe(true);
  await settle();
}
async function redo(): Promise<void> {
  expect(scene().stack.redo()).toBe(true);
  await settle();
}

describe("Inspector writes", () => {
  it("an edit writes an attribute on the element, shown at once, overriding its rule", async () => {
    expect(fieldSources(el("/#menu/#play")!).find((r) => r.field === "backgroundColor")!.origin.kind).toBe("rule");
    expect(setUIElementField(ref("/#menu/#play"), "backgroundColor", "#00ff00")).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toBe(MENU.replace(`<Button id="play" class="primary">`, `<Button id="play" class="primary" background-color="#00ff00">`));
    const play = el("/#menu/#play")!;
    expect(play.as(UIButton).backgroundColor).toEqual(Color.from("#00ff00"));
    expect(fieldSources(play).find((r) => r.field === "backgroundColor")!.origin.kind).toBe("attribute");
  });

  it("changes an attribute in place under its own spelling, and resets it", async () => {
    setUIElementField(ref("/#menu/Text[1]"), "fontSize", "24");
    await settle();
    expect(text("ui/menu.ui.xml")).toBe(MENU.replace(`font-size="20"`, `font-size="24"`));
    setUIElementField(ref("/#menu/Text[1]"), "color", null);
    await settle();
    expect(text("ui/menu.ui.xml")).toBe(MENU.replace(` color="#ff0000" font-size="20"`, ` font-size="24"`));
    expect(fieldSources(el("/#menu/Text[1]")!).find((r) => r.field === "color")!.origin.kind).toBe("inherited");
  });

  it("edits text content, and a bound text keeps showing its source", async () => {
    expect(setUIElementField(ref("/#menu/#title"), "text", "Points: {points}")).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toContain(`<Text id="title">Points: {points}</Text>`);
    expect(fieldSources(el("/#menu/#title")!).find((r) => r.field === "text")!.origin).toMatchObject({ kind: "content", bound: true });
    setUIElementText(ref("/#menu/#play/label"), "Go!");
    await settle();
    expect(text("ui/menu.ui.xml")).toContain(`<Button id="play" class="primary">Go!</Button>`);
    expect(el("/#menu/#play/label")!.as(UIText).text).toBe("Go!");
  });

  it("refuses values the field can't take", async () => {
    expect(setUIElementField(ref("/#menu/#play"), "backgroundColor", "blurple")).toBe(false);
    expect(status.value?.text).toMatch(/isn't a valid background-color/);
    expect(setUIElementField(ref("/#menu/#play"), "width", "wide")).toBe(false);
    await settle();
    expect(text("ui/menu.ui.xml")).toBe(MENU);
  });

  it("edits elements from a <Use> in their own file, and the <Use> tag's own attributes there", async () => {
    setUIElementField(ref("/#menu/#badge/Text[0]"), "fontSize", "11");
    setUIElementField(ref("/#menu/#badge"), "gap", "5");
    await settle();
    expect(text("ui/widgets/badge.ui.xml")).toBe(BADGE.replace(`gap="3"`, `gap="5"`).replace("<Text>", `<Text font-size="11">`));
    expect(text("ui/menu.ui.xml")).toBe(MENU);
    renameUIElement(ref("/#menu/#badge"), "medal"); // the id is on the <Use> tag
    await settle();
    expect(text("ui/menu.ui.xml")).toBe(MENU.replace(`id="badge"`, `id="medal"`));
    expect(selectedUIRef()).toEqual(ref("/#menu/#medal"));
    expect(el("/#menu/#medal")!.as(UIPanel).gap).toBe(5);
  });
});

describe("undo", () => {
  it("joins the scene's history: undo and redo write the files back, in order with scene edits", async () => {
    const stack = scene().stack;
    setUIElementField(ref("/#menu/#play"), "width", "200");
    await settle();
    setUIElementClasses(ref("/#menu/#title"), "big bold");
    await settle();
    expect(stack.undoLabel).toBe("Set class");
    expect(stack.dirty).toBe(false); // the files are saved as they're made; the scene didn't change
    await undo();
    expect(text("ui/menu.ui.xml")).toBe(MENU.replace(`class="primary">`, `class="primary" width="200">`));
    await undo();
    expect(text("ui/menu.ui.xml")).toBe(MENU);
    expect(el("/#menu/#play")!.as(UIButton).width).toBe("auto");
    await redo();
    expect(el("/#menu/#play")!.as(UIButton).width).toBe("200");
  });

  it("makes a gesture's edits one step (a handle drag), with the file written as it goes", async () => {
    const stack = scene().stack;
    const before = stack.allStates.length;
    expect(beginUIEdit("Resize #box")).toBe(true);
    for (const w of [60, 70, 80]) setUIElementAttributes(ref("/#box", "bare"), { width: String(w), height: String(w / 2) });
    expect(editorTextFiles.read("ui/bare.ui.xml")).toContain(`width="80" height="40"`); // reads see writes at once
    endUIEdit();
    expect(stack.allStates.length).toBe(before + 1);
    expect(stack.undoLabel).toBe("Resize #box");
    await settle();
    expect(el("/#box", "bare")!.as(UIPanel).width).toBe("80");
    await undo();
    expect(text("ui/bare.ui.xml")).toBe(BARE);
  });

  it("leaves a file changed elsewhere since the step as it is", async () => {
    setUIElementField(ref("/#menu/#play"), "width", "200");
    await settle();
    await project.writeFile("ui/menu.ui.xml", "<Canvas/>\n");
    expect(scene().stack.undo()).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toBe("<Canvas/>\n");
    expect(status.value?.text).toMatch(/changed since/);
  });
});

describe("Move to class", () => {
  it("moves the attributes into a new rule in the document's stylesheet, as CSS", async () => {
    expect(moveUIElementToClass(ref("/#menu/Text[1]"), "warning")).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toBe(MENU.replace(`<Text class="note" color="#ff0000" font-size="20">`, `<Text class="note warning">`));
    expect(text("ui/menu.ui.css")).toBe(`${MENU_CSS}\n.warning {\n  color: #ff0000;\n  font-size: 20px;\n}\n`);
    const t = el("/#menu/Text[1]")!;
    expect(t.as(UIText).fontSize).toBe(20);
    expect(fieldSources(t).find((r) => r.field === "fontSize")!.origin).toMatchObject({ kind: "rule", selector: ".warning" });
    await undo();
    expect(text("ui/menu.ui.xml")).toBe(MENU);
    expect(text("ui/menu.ui.css")).toBe(MENU_CSS);
  });

  it("extends an existing rule, keeping the id and bindings", async () => {
    setUIElementAttributes(ref("/#menu/#title"), { width: "{w}", padding: "4" });
    await settle();
    moveUIElementToClass(ref("/#menu/#title"), "column");
    await settle();
    expect(text("ui/menu.ui.css")).toContain(`.column { flex-direction: column; color: var(--fg); padding: 4px; }`);
    expect(text("ui/menu.ui.xml")).toContain(`<Text id="title" width="{w}" class="column">`);
  });

  it("says when a more specific rule still wins over the moved value", async () => {
    setUIElementField(ref("/#menu/#title"), "fontSize", "44");
    await settle();
    moveUIElementToClass(ref("/#menu/#title"), "big");
    expect(status.value?.text).toMatch(/More specific rules still win for it: #title \{ font-size \}/);
  });

  it("makes a stylesheet beside a document that has none, and links it", async () => {
    expect(moveUIElementToClass(ref("/#box", "bare"))).toBe(true); // the class is named after the id
    await settle();
    expect(text("ui/bare.ui.xml")).toBe(`<Canvas>\n  <Style src="bare.ui.css"/>\n  <Panel id="box" class="box"/>\n</Canvas>\n`);
    expect(text("ui/bare.ui.css")).toBe(`/* Styles for bare.ui.xml (ADR 0077). */\n\n.box {\n  padding: 8px;\n  background-color: #ff0000;\n  width: 50px;\n}\n`);
    const box = el("/#box", "bare")!.as(UIPanel);
    expect([box.padding, box.width]).toEqual([8, "50"]);
    expect(box.backgroundColor).toEqual(Color.from("#ff0000"));
    await undo();
    expect(project.files).not.toContain("ui/bare.ui.css");
    expect(text("ui/bare.ui.xml")).toBe(BARE);
  });

  it("formats values for stylesheets", () => {
    const info = (type: string, field: string) => getFields((type === "Text" ? UIText : UIPanel) as never).find((f) => f.name === field)!;
    expect(cssValue(info("Panel", "backgroundColor"), "rgb(0, 128, 255)")).toBe("#0080ff");
    expect(cssValue(info("Panel", "backgroundColor"), "none")).toBe("none");
    expect(cssValue(info("Panel", "width"), "auto")).toBe("auto");
    expect(cssValue(info("Panel", "width"), "50%")).toBe("50%");
    expect(cssValue(info("Panel", "flexGrow"), "1")).toBe("1");
    expect(cssValue(info("Panel", "gap"), "0")).toBe("0");
    expect(cssValue(info("Text", "text"), "Hi there")).toBe(`"Hi there"`);
    expect(cssValue(info("Panel", "flexDirection"), "column")).toBe("column");
  });
});

describe("Create", () => {
  it("adds an element into the selected one, or after a leaf, and selects it", async () => {
    const made = createUIElement("Button", ref("/#menu"));
    expect(made).toEqual(ref("/#menu/Button[1]"));
    await settle();
    expect(text("ui/menu.ui.xml")).toContain(`    <Use src="widgets/badge.ui.xml" id="badge"/>\n    <Button width="160" height="40">Button</Button>\n  </Panel>`);
    expect(selectedUIRef()).toEqual(made);
    expect(el(made!.path)!.as(UIButton).width).toBe("160");
    const after = createUIElement("Image", ref("/#menu/#title"));
    expect(after).toEqual(ref("/#menu/Image[0]"));
    await settle();
    expect(text("ui/menu.ui.xml")).toContain(`<Text id="title">Score: {score}</Text>\n    <Image width="100" height="100"/>\n`);
  });

  it("adds into a document's root, and into a self-closing element", async () => {
    expect(createUIElement("Text", { host: "bare", index: 0 })).toEqual(ref("/Text[0]", "bare"));
    await settle();
    expect(createUIElement("Panel", ref("/#box", "bare"))).toEqual(ref("/#box/Panel[0]", "bare"));
    await settle();
    expect(text("ui/bare.ui.xml")).toBe(
      `<Canvas>\n  <Panel id="box" padding="8" background-color="rgb(255, 0, 0)" width="50">\n    <Panel width="200" height="100" background-color="#2a2f3a"/>\n  </Panel>\n  <Text>New Text</Text>\n</Canvas>\n`,
    );
    expect(el("/Text[0]", "bare")!.as(UIText).text).toBe("New Text");
  });

  it("creates a new document with a Canvas root and its stylesheet", async () => {
    const path = await createUIDocument("ui");
    expect(path).toBe("ui/New UI.ui.xml");
    expect(text("ui/New UI.ui.xml")).toContain(`<Canvas>\n  <Style src="New UI.ui.css"/>`);
    expect(text("ui/New UI.ui.css")).toContain("#title");
    expect(await createUIDocument("ui")).toBe("ui/New UI 2.ui.xml");
  });
});

describe("hierarchy edits", () => {
  it("renames (sets the id), keeping the element selected", async () => {
    selectUIElement(ref("/#menu/Text[1]"));
    expect(renameUIElement(ref("/#menu/Text[1]"), "note")).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toContain(`<Text class="note" color="#ff0000" font-size="20" id="note">`);
    expect(selectedUIRef()).toEqual(ref("/#menu/#note"));
    expect(el("/#menu/#note")).not.toBeNull();
    expect(renameUIElement(ref("/#menu/#note"), "title")).toBe(false); // ids are unique in a file
    expect(renameUIElement(ref("/#menu/#note"), "two words")).toBe(false);
    renameUIElement(ref("/#menu/#note"), "");
    await settle();
    expect(selectedUIRef()).toEqual(ref("/#menu/Text[1]"));
  });

  it("deletes, selecting the parent; the root can't be", async () => {
    expect(deleteUIElement(ref("/#menu/#play"))).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toBe(MENU.replace(`    <Button id="play" class="primary">Play</Button>\n`, ""));
    expect(selectedUIRef()).toEqual(ref("/#menu"));
    expect(deleteUIElement(ref(""))).toBe(false);
    deleteUIElement(ref("/#menu/#badge")); // a used document: its <Use> tag goes
    await settle();
    expect(text("ui/menu.ui.xml")).not.toContain("<Use");
    expect(text("ui/widgets/badge.ui.xml")).toBe(BADGE);
  });

  it("duplicates with a fresh id, selecting the copy", async () => {
    expect(duplicateUIElement(ref("/#menu/#play"))).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toContain(`Play</Button>\n    <Button id="play-2" class="primary">Play</Button>\n`);
    expect(selectedUIRef()).toEqual(ref("/#menu/#play-2"));
    expect(el("/#menu/#play-2")).not.toBeNull();
  });

  it("reorders and reparents within the file, not across files", async () => {
    expect(moveUIElement(ref("/#menu/#play"), ref("/#menu"), 0)).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toContain(`class="column" padding="12">\n    <Button id="play" class="primary">Play</Button>\n    <Text id="title">`);
    expect(selectedUIRef()).toEqual(ref("/#menu/#play"));
    expect(moveUIElement(ref("/#menu/Text[1]"), ref(""), 99)).toBe(true);
    await settle();
    expect(selectedUIRef()).toEqual(ref("/Text[0]"));
    expect(text("ui/menu.ui.xml")).toContain(`  </Panel>\n  <Text class="note" color="#ff0000" font-size="20">Plain</Text>\n</Canvas>`);
    expect(whyNotMovable(ref("/#menu/#title"), ref("/#menu/#badge"))).toMatch(/own file/);
    expect(whyNotMovable(ref("/#menu"), ref("/#menu/#play"))).toMatch(/inside itself/);
    expect(whyNotMovable(ref("/#menu/#play"), ref("/#box", "bare"))).toMatch(/own document/);
    await undo();
    await undo();
    expect(text("ui/menu.ui.xml")).toBe(MENU);
  });
});

describe("read-only", () => {
  it("refuses every edit in a read-only project (a sample), saying why", async () => {
    engine.dispose();
    openScene.value = null;
    const values = new Map<string, unknown>(), texts = new Map<string, string>();
    for (const [path, t] of Object.entries(FILES)) {
      values.set(path, path.endsWith(".json") ? JSON.parse(t) : t);
      texts.set(path, t);
    }
    await open(readOnlyProject("Sample", { values, texts }));
    expect(el("/#menu/#play")).not.toBeNull();
    const before = scene().stack.allStates.length;
    expect(setUIElementField(ref("/#menu/#play"), "width", "10")).toBe(false);
    expect(status.value?.text).toMatch(/read-only/);
    expect(moveUIElementToClass(ref("/#menu/Text[1]"))).toBe(false);
    expect(createUIElement("Text", ref("/#menu"))).toBeNull();
    expect(deleteUIElement(ref("/#menu/#play"))).toBe(false);
    expect(beginUIEdit("drag")).toBe(false);
    expect(await createUIDocument("ui")).toBeNull();
    expect(scene().stack.allStates.length).toBe(before);
    expect(project.textOf("ui/menu.ui.xml")).toBe(MENU);
  });

  it("refuses while playing", () => {
    playState.value = "playing";
    expect(setUIElementField(ref("/#menu/#play"), "width", "10")).toBe(false);
    expect(status.value?.text).toMatch(/stop playing/);
  });
});

describe("documents keep building", () => {
  it("the host's UIDocument rebuilds from the new text", async () => {
    setUIElementField(ref("/#menu/#play"), "width", "300");
    await settle();
    const doc = scene().sync.nodeFor("hud")!.getComponent(UIDocument)!;
    expect(doc.query("#play")!.as(UIButton).width).toBe("300");
  });
});

describe("menus", () => {
  it("the Create menu adds elements into the selected element or the selected node's document; element rows have a menu", async () => {
    const { createMenuItems, uiElementMenuItems } = await import("./ui/HierarchyMenu");
    select([]);
    expect(createMenuItems(scene()).some((i) => i.label.includes("in Document"))).toBe(false);
    select(["bare"]);
    const items = createMenuItems(scene());
    expect(items.slice(0, 5).map((i) => i.label)).toEqual(["Create Panel in Document", "Create Text in Document", "Create Image in Document", "Create Button in Document", "Create Input Field in Document"]);
    items[1].run!();
    await settle();
    expect(selectedUIRef()).toEqual(ref("/Text[0]", "bare"));
    expect(text("ui/bare.ui.xml")).toContain("<Text>New Text</Text>");
    const rowItems = uiElementMenuItems(scene(), ref(""));
    expect(rowItems.find((i) => i.label === "Delete")!.disabled).toMatch(/root/);
    expect(uiElementMenuItems(scene(), ref("/#menu/#play")).find((i) => i.label === "Duplicate")!.disabled).toBeNull();
  });

  it("Delete and Duplicate act on a selected element", async () => {
    const { deleteSelected } = await import("./deleteSelection");
    const { duplicateSelection } = await import("./hierarchyActions");
    selectUIElement(ref("/#menu/#play"));
    expect(duplicateSelection()).toBe(true);
    await settle();
    expect(selectedUIRef()).toEqual(ref("/#menu/#play-2"));
    expect(await deleteSelected()).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toBe(MENU);
  });
});
