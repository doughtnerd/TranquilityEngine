import { describe, expect, it } from "vitest";
import { isEditable } from "../editable";
import { activeElementOf, eventWindow, isElement, isKeyboardEvent, isTag, ownerDocumentOf, ownerWindowOf, viewportOf } from "./dom";

// Fake windows and documents: the helpers duck-type them, so a child window's objects (another realm) work.
function fakeWindow(name: string, size = { innerWidth: 800, innerHeight: 600 }) {
  const win = { name, ...size, document: null as unknown as Document } as unknown as Window & { name: string };
  (win as { window: unknown }).window = win;
  const doc = { nodeType: 9, defaultView: win, activeElement: null as Element | null } as unknown as Document;
  (win as { document: Document }).document = doc;
  return { win, doc };
}
const element = (doc: Document, tagName: string, extra: Record<string, unknown> = {}) => ({ nodeType: 1, tagName: tagName.toUpperCase(), ownerDocument: doc, ...extra }) as unknown as HTMLElement;

describe("owner-document helpers (ADR 0174, detached windows)", () => {
  const child = fakeWindow("child", { innerWidth: 320, innerHeight: 240 });

  it("find an element's own document and window, not the main window's", () => {
    const el = element(child.doc, "div");
    expect(ownerDocumentOf(el)).toBe(child.doc);
    expect(ownerWindowOf(el)).toBe(child.win);
    expect(ownerDocumentOf(child.doc)).toBe(child.doc);
    expect(ownerWindowOf(child.win)).toBe(child.win);
    expect(ownerDocumentOf(child.win)).toBe(child.doc);
  });

  it("measure the element's own viewport and focus", () => {
    const el = element(child.doc, "div");
    expect(viewportOf(el)).toEqual({ width: 320, height: 240 });
    (child.doc as { activeElement: unknown }).activeElement = el;
    expect(activeElementOf(el)).toBe(el);
  });

  it("find the window an event happened in from its target", () => {
    const el = element(child.doc, "button");
    expect(eventWindow({ target: el } as unknown as Event)).toBe(child.win);
    expect(eventWindow({ target: child.win } as unknown as Event)).toBe(child.win);
    expect(eventWindow({ target: null, view: child.win } as unknown as Event)).toBe(child.win);
  });

  it("test tags and keyboard events without the main realm's constructors", () => {
    const input = element(child.doc, "input", { type: "text" });
    expect(isTag(input, "input")).toBe(true);
    expect(isTag(input, "button")).toBe(false);
    expect(isElement(input)).toBe(true);
    expect(isElement(child.doc)).toBe(false);
    expect(isKeyboardEvent({ type: "keydown", key: "Escape" } as unknown as Event)).toBe(true);
    expect(isKeyboardEvent({ type: "pointerdown" } as unknown as Event)).toBe(false);
  });

  it("isEditable recognises a child window's text fields (no instanceof)", () => {
    expect(isEditable(element(child.doc, "input", { type: "text" }))).toBe(true);
    expect(isEditable(element(child.doc, "input", { type: "checkbox" }))).toBe(false);
    expect(isEditable(element(child.doc, "textarea"))).toBe(true);
    expect(isEditable(element(child.doc, "select"))).toBe(true);
    expect(isEditable(element(child.doc, "div", { isContentEditable: true }))).toBe(true);
    expect(isEditable(element(child.doc, "button"))).toBe(false);
    expect(isEditable(child.win)).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});
