// The editor's clipboard text (ADR 0226), through its interface: payloads written to a stand-in
// system clipboard, read back from text, which copy a paste takes, and paste events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clipboardForPaste, clipboardText, expectPaste, readClipboard, takePaste, writeClipboard } from "./clipboard";

interface Thing {
  format: "test.things@1";
  things: string[];
}
const thing = (...things: string[]): Thing => ({ format: "test.things@1", things });
const read = (text: string) => readClipboard<Thing>(text, "test.things@1", (v) => Array.isArray((v as Thing).things));

/** The system clipboard's text; `refuse` makes writes fail, as a browser without permission does. */
let system = "";
let refuse = false;
beforeEach(() => {
  system = "";
  refuse = false;
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: (text: string) => {
        if (refuse) return Promise.reject(new Error("not allowed"));
        system = text;
        return Promise.resolve();
      },
    },
  });
});
afterEach(() => void vi.unstubAllGlobals());

const paste = (text: string | null) => ({ clipboardData: { getData: (type: string) => (type === "text/plain" ? (text ?? "") : "") }, preventDefault: vi.fn() });

describe("clipboard text", () => {
  it("reads back what it writes", () => {
    writeClipboard(thing("a", "b"));
    expect(system).toBe(clipboardText(thing("a", "b")));
    expect(read(system)).toEqual(thing("a", "b"));
  });

  it("reads nothing from text of another format, malformed payloads or text that isn't JSON", () => {
    expect(read(clipboardText({ format: "test.other@1" }))).toBeNull();
    expect(read(JSON.stringify({ format: "test.things@1", things: 3 }))).toBeNull();
    expect(read("hello")).toBeNull();
    expect(read("null")).toBeNull();
  });
});

describe("which copy a paste takes", () => {
  it("takes text another editor wrote over this editor's own copy", async () => {
    writeClipboard(thing("mine"));
    await Promise.resolve();
    const elsewhere = clipboardText(thing("theirs"));
    expect(clipboardForPaste(elsewhere, thing("mine"), read)).toEqual(thing("theirs"));
  });

  it("takes this editor's copy when the text is what it wrote, or isn't a payload", async () => {
    const mine = thing("mine");
    writeClipboard(mine);
    await Promise.resolve();
    expect(clipboardForPaste(system, mine, read)).toBe(mine);
    expect(clipboardForPaste("some text copied from a browser", mine, read)).toBe(mine);
    expect(clipboardForPaste(null, mine, read)).toBe(mine);
  });

  it("takes this editor's copy when it never reached the system clipboard (the text is older)", async () => {
    refuse = true;
    const mine = thing("mine");
    writeClipboard(mine);
    await Promise.resolve();
    await Promise.resolve();
    expect(clipboardForPaste(clipboardText(thing("older")), mine, read)).toBe(mine);
  });

  it("takes the text when this editor has copied nothing", () => {
    expect(clipboardForPaste(clipboardText(thing("theirs")), null, read)).toEqual(thing("theirs"));
    expect(clipboardForPaste("junk", null, read)).toBeNull();
  });
});

describe("paste events", () => {
  it("a paste waiting for its event gets the event's text, once", async () => {
    const run = vi.fn();
    expectPaste(run);
    const e = paste("copied");
    takePaste(e);
    expect(run).toHaveBeenCalledExactlyOnceWith("copied");
    expect(e.preventDefault).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 5));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs with no text on the next task when no event comes", async () => {
    const run = vi.fn();
    expectPaste(run);
    expect(run).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(run).toHaveBeenCalledExactlyOnceWith(null));
  });

  it("an event with no paste waiting goes to the handler given, or is left alone", () => {
    const run = vi.fn();
    takePaste(paste("x"), run);
    expect(run).toHaveBeenCalledWith("x");
    const e = paste("y");
    takePaste(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
