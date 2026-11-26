import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameBehavior, GameObject, Input, defineSystem } from "../index";
import { UIButton, UIInputField } from "../ui/components";
import { UIDocument, UIEvents, loadUIDocumentSupport } from "../ui/UIDocument";
import { _undefineSystem } from "../core/systems";
import { World } from "../core/World";
import { UIPointer, stubDocument, type FakeInput } from "./uiPointer";
import { buildUI, byId } from "./uiMarkup";

// ADR 0309: what the player did to UI (click, submit, change, hover) is recorded once, by the UI core,
// and every script phase of the World's next frame sees it; a script's own edits are never the player's.

const DT = 1 / 60;
let engine: Engine;
let files: Record<string, unknown>;
let pointers: UIPointer[] = [];
let dom: FakeInput;
const systems: string[] = [];

beforeEach(async () => {
  Input.reset();
  files = {
    "ui/form.ui.xml": `<Canvas><Panel id="form" flex-direction="column"><Button id="go" width="200" height="50">Go</Button><InputField id="name" width="300" height="40"/></Panel></Canvas>`,
  };
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files));
  engine = await Engine.create({ headless: true });
  await loadUIDocumentSupport();
  dom = stubDocument();
});

afterEach(() => {
  for (const p of pointers.splice(0)) p.dispose();
  for (const name of systems.splice(0)) _undefineSystem(name);
  vi.unstubAllGlobals();
  engine.dispose();
  Assets.clearSources();
  Input.reset();
});

async function pointer(): Promise<UIPointer> {
  const p = await UIPointer.create(World.require());
  pointers.push(p);
  return p;
}

async function form(): Promise<UIDocument> {
  const doc = GameObject.create("UI").addBehavior(UIDocument, { document: "asset:ui/form.ui.xml" });
  await doc.ready;
  return doc;
}

/** Focus `field` as a script does, and let the renderer's sync give it the DOM input. */
function focus(p: UIPointer, field: UIInputField): void {
  field.focused = true;
  p.sync();
}

describe("UI interaction events (ADR 0309)", () => {
  it("gives two clicks on two buttons in one long frame each to its own button, in order", async () => {
    const doc = buildUI(`<Canvas><Panel flex-direction="row"><Button id="a" width="100" height="50">A</Button><Button id="b" width="100" height="50">B</Button></Panel></Canvas>`);
    const a = byId(doc, "a", UIButton);
    const b = byId(doc, "b", UIButton);
    const p = await pointer();
    const seen: string[] = [];
    const frame = () => {
      engine.step(DT);
      p.sync();
      seen.push(`${a.clicked ? "a" : ""}${b.clicked ? "b" : ""}`);
    };
    frame();
    p.click(a);
    p.click(b); // before the World steps again: the second press waits in the queue
    for (let i = 0; i < 4; i++) frame();
    expect(seen).toEqual(["", "a", "", "b", ""]);
  });

  it("doesn't report a script's value write in fixedUpdate as a change", async () => {
    const doc = await form();
    const name = doc.query("#name")!;
    const changes: unknown[] = [];
    name.on("change", (e) => changes.push(e));
    let n = 0;
    class Writer extends GameBehavior {
      fixedUpdate() {
        name.as(UIInputField).value = `tick ${n++}`;
      }
    }
    GameObject.create("Writer").addBehavior(Writer);
    for (let i = 0; i < 5; i++) engine.step(DT);
    expect(n).toBeGreaterThan(0);
    expect(changes).toHaveLength(0);
    expect(name.changed).toBe(false);
  });

  it("doesn't report a script's value write in a system before the document events as a change", async () => {
    const doc = await form();
    const name = doc.query("#name")!;
    const changes: unknown[] = [];
    name.on("change", (e) => changes.push(e));
    systems.push("test.uiInteractions.write");
    let n = 0;
    defineSystem({ name: "test.uiInteractions.write", phase: "update", before: ["engine.UIDocumentEvents"], run: () => void (name.as(UIInputField).value = `frame ${n++}`) });
    for (let i = 0; i < 3; i++) engine.step(DT);
    expect(n).toBe(3);
    expect(changes).toHaveLength(0);
  });

  it("shows clicked, changed and submitted in the same frame, to fixedUpdate as well as update", async () => {
    const doc = await form();
    const go = doc.query("#go")!.as(UIButton);
    const name = doc.query("#name")!.as(UIInputField);
    const p = await pointer();
    const seen: { phase: string; frame: number; clicked: boolean; changed: boolean; submitted: boolean }[] = [];
    class Watcher extends GameBehavior {
      fixedUpdate() {
        seen.push({ phase: "fixed", frame: this.time.frameCount, clicked: go.clicked, changed: name.changed, submitted: name.submitted });
      }
      update() {
        seen.push({ phase: "update", frame: this.time.frameCount, clicked: go.clicked, changed: name.changed, submitted: name.submitted });
      }
    }
    GameObject.create("Watcher").addBehavior(Watcher);
    p.hover(go);
    p.dom.pointerDown(0);
    engine.step(DT);
    // Between frames: the player types and presses Enter in the field, and releases over Go.
    focus(p, name);
    dom.typeText("Ada");
    dom.emit("keydown", { key: "Enter" });
    p.dom.pointerUp(0);
    seen.length = 0;
    engine.step(DT);
    const frame = World.require().time.frameCount;
    expect(seen.some((s) => s.phase === "fixed")).toBe(true);
    for (const s of seen) expect(s, s.phase).toEqual({ phase: s.phase, frame, clicked: true, changed: true, submitted: true });
    seen.length = 0;
    engine.step(DT);
    for (const s of seen) expect(s, s.phase).toMatchObject({ clicked: false, changed: false, submitted: false });
  });

  it("gives an input field no handler watches `changed` for the frame the player typed, and never for a script's write", async () => {
    const field = byId(buildUI(`<Canvas><InputField id="name" width="300" height="40"/></Canvas>`), "name", UIInputField);
    const p = await pointer();
    focus(p, field);
    dom.typeText("Ada");
    expect(field.value).toBe("Ada"); // the value is there at once
    expect(field.changed).toBe(false); // the event is the next frame's
    engine.step(DT);
    expect(field.changed).toBe(true);
    engine.step(DT);
    expect(field.changed).toBe(false);
    field.value = "Zed";
    engine.step(DT);
    expect(field.changed).toBe(false);
  });

  it("drops a submit whose field lost focus before the frame", async () => {
    const doc = await form();
    const name = doc.query("#name")!.as(UIInputField);
    const p = await pointer();
    focus(p, name);
    dom.emit("keydown", { key: "Enter" });
    name.focused = false;
    engine.step(DT);
    expect(name.submitted).toBe(false);
  });

  it("reports hover once each time the pointer moves onto a button, in UIEvents and handlers", async () => {
    const doc = await form();
    const go = doc.query("#go")!;
    const hovers: number[] = [];
    let rows = 0;
    go.on("hover", () => {
      hovers.push(World.require().time.frameCount);
      rows += UIEvents.read().filter((e) => e.type === "hover").length;
    });
    const p = await pointer();
    p.hover(go.as(UIButton));
    engine.step(DT);
    engine.step(DT);
    p.leave();
    engine.step(DT);
    expect(go.hovered).toBe(false);
    p.hover(go.as(UIButton));
    engine.step(DT);
    expect(hovers).toHaveLength(2);
    expect(rows).toBe(2);
    expect(go.hovered).toBe(true);
  });

  it("keeps one focused field per World: focusing another, in another document, moves focus", async () => {
    const doc = await form();
    const name = doc.query("#name")!.as(UIInputField);
    const other = byId(buildUI(`<Canvas><InputField id="other"/></Canvas>`), "other", UIInputField);
    name.focused = true;
    other.focused = true;
    expect(name.focused).toBe(false);
    expect(other.focused).toBe(true);
    name.focused = false; // unfocusing a field that hasn't focus leaves focus where it is
    expect(other.focused).toBe(true);
  });
});
