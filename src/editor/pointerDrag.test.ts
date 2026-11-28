// The editor's one press-and-drag gesture (pointerDrag.ts, ADR 0455), headless: the press's window is an
// EventTarget standing in for a (possibly detached, ADR 0174) panel window, and the gesture runs on dispatched events.
import { describe, expect, it } from "vitest";
import { isDragDistance, startPointerDrag, type PointerDragEnd } from "./pointerDrag";

const win = Object.assign(new EventTarget(), { document: { title: "panel window" } });
const pointer = (type: string, x: number, y = 0, button = 0) =>
  Object.assign(new Event(type), { clientX: x, clientY: y, button, view: win }) as unknown as PointerEvent;
const key = (k: string) => Object.assign(new Event("keydown", { cancelable: true }), { key: k });

/** Press at (0, 0) and record what the handlers hear. */
function press(button = 0) {
  const log: string[] = [];
  const ends: PointerDragEnd[] = [];
  startPointerDrag(pointer("pointerdown", 0, 0, button), {
    begin: (e, doc) => log.push(`begin ${e.clientX} ${doc === (win.document as unknown as Document)}`),
    move: (e, doc) => log.push(`move ${e.clientX} ${doc === (win.document as unknown as Document)}`),
    end: (how) => ends.push(how),
  });
  return { log, ends };
}

describe("startPointerDrag", () => {
  it("a press released before the threshold is a click, with no begin or move", () => {
    const { log, ends } = press();
    win.dispatchEvent(pointer("pointermove", 4));
    win.dispatchEvent(pointer("pointerup", 4));
    expect(log).toEqual([]);
    expect(ends).toEqual(["click"]);
  });

  it("past the threshold it begins once, moves in the press's window, and drops at the release point", () => {
    const { log, ends } = press();
    win.dispatchEvent(pointer("pointermove", 5));
    win.dispatchEvent(pointer("pointermove", 2)); // back under the threshold: still dragging
    win.dispatchEvent(pointer("pointerup", 9));
    expect(log).toEqual(["begin 5 true", "move 5 true", "move 2 true", "move 9 true"]);
    expect(ends).toEqual(["drop"]);
  });

  it("Escape cancels a drag and swallows the key; before the drag it's left alone", () => {
    const { ends } = press();
    const early = key("Escape");
    win.dispatchEvent(early);
    expect(early.defaultPrevented).toBe(false);
    expect(ends).toEqual([]);
    win.dispatchEvent(pointer("pointermove", 20));
    const late = key("Escape");
    win.dispatchEvent(late);
    expect(late.defaultPrevented).toBe(true);
    expect(ends).toEqual(["cancel"]);
  });

  it("a cancelled pointer ends the press, dragging or not, and every listener goes with it", () => {
    // The Assets panel's selection box once ignored pointercancel, leaving its box and move listener up (ADR 0455).
    for (const dragging of [false, true]) {
      const { log, ends } = press();
      if (dragging) win.dispatchEvent(pointer("pointermove", 30));
      win.dispatchEvent(pointer("pointercancel", 0));
      expect(ends).toEqual(["cancel"]);
      const heard = log.length;
      win.dispatchEvent(pointer("pointermove", 60));
      win.dispatchEvent(pointer("pointerup", 60));
      win.dispatchEvent(key("Escape"));
      expect(log.length).toBe(heard);
      expect(ends).toEqual(["cancel"]);
    }
  });

  it("ignores presses of other buttons", () => {
    const { log, ends } = press(2);
    win.dispatchEvent(pointer("pointermove", 40));
    win.dispatchEvent(pointer("pointerup", 40));
    expect(log).toEqual([]);
    expect(ends).toEqual([]);
  });
});

describe("isDragDistance", () => {
  it("is the same threshold the gesture uses", () => {
    expect(isDragDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 3.9 })).toBe(false);
    expect(isDragDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 })).toBe(true);
    expect(isDragDistance({ clientX: 10, clientY: 10 }, { clientX: 10, clientY: 5 })).toBe(true);
  });
});
