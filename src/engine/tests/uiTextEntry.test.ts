import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input } from "../index";
import { UICanvas, UIInputField, UIText, UITextArea } from "../ui/components";
import { World } from "../core/World";
import { UIPointer } from "./uiPointer";
import { MemoryTextEntry } from "./memoryTextEntry";
import { buildUI, byId, loadUITestSupport, uiElement } from "./uiMarkup";

// ADR 0449: the UI core takes typing through the text entry port it's given. Here it's given one held in memory, so
// typing, the caret and selection, Enter, Escape, Tab, an IME composing and focus leaving run in Node through the same
// bridge the browser's hidden DOM elements use. Clicks go in through `Input`'s DOM adapter (`UIPointer`).

const DT = 1 / 60;
let engine: Engine;
let pointers: UIPointer[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
  await loadUITestSupport();
});

afterEach(() => {
  for (const p of pointers.splice(0)) p.dispose();
  engine.dispose();
  Input.reset();
  vi.restoreAllMocks();
});

const node = uiElement;

/** A core routing this World's UI that types through a text entry in memory. */
async function typing(): Promise<{ p: UIPointer; entry: MemoryTextEntry }> {
  const entry = new MemoryTextEntry();
  const p = await UIPointer.create(World.require(), 1280, 720, { textEntry: entry });
  pointers.push(p);
  return { p, entry };
}

/** Step a frame, then lay out as the renderer does after it (focus moves into the box at the layout). */
function frame(p: UIPointer): void {
  engine.step(DT);
  p.sync();
}

describe("input fields through a text entry in memory (ADR 0449)", () => {
  it("gives the box to the field a click focuses, and takes typing within maxLength, a change following", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const field = node("Name", canvas.node, UIInputField, { width: 300, height: 40, value: "Ad", maxLength: 5 } as Partial<UIInputField>);
    const { p, entry } = await typing();
    expect(entry.boxes).toHaveLength(0); // nothing until a field types

    p.click(field);
    frame(p);
    expect(field.typing).toBe(true);
    expect(entry.box.value).toBe("Ad");
    expect(entry.box.maxLength).toBe(5);
    expect(p.core.caretOf(field)).toBe(2); // the caret at the end

    entry.type("a Lovelace");
    expect(field.value).toBe("Ada L");
    engine.step(DT);
    expect(field.changed).toBe(true);
    engine.step(DT);
    expect(field.changed).toBe(false);
  });

  it("follows the caret and the selection the player moves, and edits there", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const field = node("Name", canvas.node, UIInputField, { width: 300, height: 40 } as Partial<UIInputField>);
    const { p, entry } = await typing();
    field.focused = true;
    p.sync();
    entry.type("Hello");
    entry.press("ArrowLeft");
    entry.press("ArrowLeft");
    expect(p.core.caretOf(field)).toBe(3);
    expect(p.core.selectionOf(field)).toBeNull();

    entry.press("ArrowLeft", { shift: true });
    expect(p.core.selectionOf(field)).toEqual([2, 3]);
    entry.type("X"); // over the selection
    expect(field.value).toBe("HeXlo");
    entry.press("Backspace");
    expect(field.value).toBe("Helo");
    entry.press("End", { shift: true });
    expect(p.core.selectionOf(field)).toEqual([2, 4]);
    entry.press("Delete");
    expect(field.value).toBe("He");
    expect(p.core.caretOf(field)).toBe(2);
  });

  it("submits on Enter for the next frame, and stops typing on Escape with focus kept (ADR 0340)", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const field = node("Name", canvas.node, UIInputField, { width: 300, height: 40 } as Partial<UIInputField>);
    const { p, entry } = await typing();
    field.focused = true;
    p.sync();
    entry.type("Ada");
    entry.press("Enter");
    expect(field.submitted).toBe(false);
    engine.step(DT);
    expect(field.submitted).toBe(true);
    engine.step(DT);
    expect(field.submitted).toBe(false);

    entry.press("Escape");
    frame(p);
    expect(field.typing).toBe(false);
    expect(field.focused).toBe(true);
    expect(entry.focusedBox).toBeNull(); // the box let go of the keyboard
    expect(p.core.caretOf(field)).toBeNull();
    expect(field.value).toBe("Ada");
  });

  it("leaves Enter and Escape to an IME while it composes (ADR 0356)", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const field = node("Name", canvas.node, UIInputField, { width: 300, height: 40 } as Partial<UIInputField>);
    const { p, entry } = await typing();
    field.focused = true;
    p.sync();
    entry.press("Enter", { composing: true });
    entry.press("Escape", { composing: true });
    engine.step(DT);
    expect(field.submitted).toBe(false);
    expect(field.typing).toBe(true);
  });

  it("moves focus to the next field on Tab, keeping the box's own focus change from happening", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const a = node("A", canvas.node, UIInputField, { width: 300, height: 40 } as Partial<UIInputField>);
    const b = node("B", canvas.node, UIInputField, { width: 300, height: 40 } as Partial<UIInputField>);
    const { p, entry } = await typing();
    a.focused = true;
    p.sync();
    const box = entry.box;
    entry.press("Tab");
    expect(box.focused).toBe(true); // prevented: the platform's focus change didn't blur it
    engine.step(DT);
    expect(a.focused).toBe(false);
    expect(b.focused).toBe(true);
  });

  it("mirrors a script's write into the box, and unfocuses the field when the keyboard leaves", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const field = node("Name", canvas.node, UIInputField, { width: 300, height: 40, value: "Ada" } as Partial<UIInputField>);
    const { p, entry } = await typing();
    field.focused = true;
    p.sync();
    expect(entry.box.value).toBe("Ada");
    field.value = "Zed";
    p.sync();
    expect(entry.box.value).toBe("Zed");
    entry.leave();
    expect(field.focused).toBe(false);
  });

  it("shares one box between one-line fields and types a text area in a multi-line one, where Enter starts a line", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const a = node("A", canvas.node, UIInputField, { width: 300, height: 40, value: "aa" } as Partial<UIInputField>);
    const b = node("B", canvas.node, UIInputField, { width: 300, height: 40, value: "bb" } as Partial<UIInputField>);
    const notes = node("Notes", canvas.node, UITextArea, { width: 300, height: 80 } as Partial<UITextArea>);
    const { p, entry } = await typing();
    a.focused = true;
    p.sync();
    const line = entry.box;
    b.focused = true;
    p.sync();
    expect(entry.box).toBe(line);
    expect(line.value).toBe("bb");
    entry.type("b");
    expect([a.value, b.value]).toEqual(["aa", "bbb"]);

    notes.focused = true;
    p.sync();
    expect(entry.box).not.toBe(line);
    expect(entry.box.multiline).toBe(true);
    entry.type("x");
    entry.press("Enter");
    entry.type("y");
    expect(notes.value).toBe("x\ny");
    engine.step(DT);
    expect(notes.submitted).toBe(false);
    expect(entry.boxes).toHaveLength(2);
  });

  it("lets go of the box when the field is removed, and removes the boxes with the core", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const field = node("Name", canvas.node, UIInputField, { width: 300, height: 40 } as Partial<UIInputField>);
    const { p, entry } = await typing();
    field.focused = true;
    p.sync();
    expect(entry.focusedBox).not.toBeNull();
    GameObject.destroy(field.owner);
    frame(p);
    expect(entry.focusedBox).toBeNull();
    p.dispose();
    expect(entry.boxes.every((b) => b.removed)).toBe(true);
  });
});

describe("editable text through a text entry in memory (ADR 0429, 0449)", () => {
  async function editable() {
    const ui = buildUI(`<Canvas><p id="p" contenteditable="true" width="300">Edit me</p><button id="away" width="100" height="40">Away</button></Canvas>`);
    const text = byId(ui, "p", UIText);
    const events: string[] = [];
    for (const type of ["focus", "input", "blur"] as const) ui.query("#p")!.on(type, () => events.push(type));
    const { p, entry } = await typing();
    // A press at the end of its text puts the caret there.
    const at = p.pointIn(text, 0.99, 0.5);
    p.dom.moveTo(at.x, at.y);
    p.dom.click();
    frame(p);
    const laid = () => p.core.elements().find((e) => e.comp === text)!;
    return { ui, text, events, p, entry, laid };
  }

  it("holds its text in the multi-line box with the caret where the press was, and takes typing into its runs", async () => {
    const { events, p, entry, laid } = await editable();
    expect(entry.box.multiline).toBe(true);
    expect(entry.box.value).toBe("Edit me");
    expect(entry.box.selectionStart).toBe(7);
    expect(laid().editing?.caret).not.toBeNull();
    expect(events).toEqual(["focus"]);

    entry.press("Backspace");
    entry.type("!");
    frame(p);
    expect(laid().text?.text).toBe("Edit m!");
    expect(events.filter((e) => e === "input").length).toBeGreaterThan(0);
  });

  it("shows the selection the player makes with the keys, and stops editing on Escape", async () => {
    const { events, p, entry, laid } = await editable();
    entry.press("ArrowLeft", { shift: true });
    entry.press("ArrowLeft", { shift: true });
    p.sync(); // the layout takes the box's selection in…
    p.sync(); // …and the next one shows it
    expect(laid().editing?.caret).toBeNull();
    expect(laid().editing?.selection.length).toBe(1);

    entry.press("Escape");
    expect(entry.focusedBox).toBeNull();
    frame(p);
    expect(laid().editing ?? null).toBeNull();
    expect(events.at(-1)).toBe("blur");
  });

  it("stops editing on a press elsewhere", async () => {
    const { ui, events, p, entry, laid } = await editable();
    frame(p); // the first click's release
    p.click(ui.query("#away")!.component);
    frame(p);
    expect(entry.focusedBox).toBeNull();
    expect(laid().editing ?? null).toBeNull();
    engine.step(DT); // `blur` is sent the frame after
    expect(events).toEqual(["focus", "blur"]);
  });
});
