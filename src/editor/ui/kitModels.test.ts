// The component kit's pure models (ADR 0349): context menu keys, toasts with an Undo, segmented control keys, the
// Move to… rules, key combos, the shortcuts list and the History popover's words.
import { describe, expect, it, vi } from "vitest";
import { SEPARATOR, edgeIndex, hasCheckColumn, stepIndex, tidyEntries, typeaheadIndex, type MenuEntry } from "./contextMenuModel";
import { historyPopoverText } from "./historyPopoverModel";
import { formatCombo, formatKeys, isSingleKey, matchesCombo, parseCombo, type KeyEventLike } from "./keyCombo";
import { allFolders, folderTree, isCurrentFolder, searchFolders, whyNotMoveTo } from "./moveToModel";
import { segmentForKey } from "./segmentedModel";
import { numberBoxCommit, numberBoxStep, numberBoxText } from "./panelFieldsModel";
import { shownShortcuts } from "./shortcutListModel";
import { INFO_TOAST_MS, UNDO_TOAST_MS, createToastQueue } from "./undoToastModel";

const item = (id: string, disabled = false): MenuEntry => ({ id, label: id, disabled, run() {} });

describe("context menu", () => {
  const entries = [item("Rename"), SEPARATOR, item("Move", true), item("Duplicate"), SEPARATOR, item("Delete")];

  it("steps over separators and disabled items, wrapping", () => {
    expect(stepIndex(entries, -1, 1)).toBe(0);
    expect(stepIndex(entries, 0, 1)).toBe(3);
    expect(stepIndex(entries, 5, 1)).toBe(0);
    expect(stepIndex(entries, 0, -1)).toBe(5);
    expect(edgeIndex(entries, "last")).toBe(5);
    expect(stepIndex([SEPARATOR, item("x", true)], -1, 1)).toBe(-1);
    expect(stepIndex([], -1, 1)).toBe(-1);
  });

  it("jumps to the next usable item starting with a typed letter", () => {
    expect(typeaheadIndex(entries, 0, "d")).toBe(3);
    expect(typeaheadIndex(entries, 3, "D")).toBe(5);
    expect(typeaheadIndex(entries, 5, "d")).toBe(3);
    expect(typeaheadIndex(entries, 0, "m")).toBe(-1); // Move is disabled
    expect(typeaheadIndex(entries, 0, " ")).toBe(-1);
  });

  it("drops stray separators and left-out parts", () => {
    const tidy = tidyEntries([SEPARATOR, item("a"), null, SEPARATOR, SEPARATOR, false, item("b"), SEPARATOR]);
    expect(tidy.map((e) => ("id" in e ? e.id : "-"))).toEqual(["a", "-", "b"]);
  });

  it("skips group headings, drops one with nothing under it, and draws a check column only when an item can be checked", () => {
    const group = (label: string): MenuEntry => ({ kind: "group", label });
    const menu: MenuEntry[] = [group("Play mode"), item("Whole"), item("Loop")];
    expect(stepIndex(menu, -1, 1)).toBe(1);
    expect(stepIndex(menu, 1, -1)).toBe(2);
    const tidy = tidyEntries([group("Empty"), SEPARATOR, item("a"), group("Also empty"), group("Kept"), item("b"), group("Trailing")]);
    expect(tidy.map((e) => ("id" in e ? e.id : "label" in e ? e.label : "-"))).toEqual(["a", "Kept", "b"]);
    expect(hasCheckColumn(menu)).toBe(false);
    expect(hasCheckColumn([...menu, { id: "c", label: "Cycle", checked: false, run() {} }])).toBe(true);
  });
});

describe("toasts with an Undo", () => {
  it("stay 10 s with an Undo, 5 s without, and leave when their time is up", () => {
    const q = createToastQueue();
    q.show({ text: "Deleted Engine loop", undo() {} });
    expect(q.toasts.value.map((t) => t.remaining)).toEqual([UNDO_TOAST_MS]);
    q.tick(UNDO_TOAST_MS - 1);
    expect(q.toasts.value.map((t) => t.text)).toEqual(["Deleted Engine loop"]);
    q.tick(1);
    expect(q.toasts.value).toEqual([]);
    q.show({ text: "Saved" });
    expect(q.toasts.value.map((t) => t.remaining)).toEqual([INFO_TOAST_MS]);
    q.tick(INFO_TOAST_MS);
    expect(q.toasts.value).toEqual([]);
  });

  it("runs an Undo once, never after the toast has gone", () => {
    const q = createToastQueue();
    const undo = vi.fn();
    const id = q.show({ text: "Moved 2 takes", undo });
    expect(q.undo(id)).toBe(true);
    expect(q.undo(id)).toBe(false);
    expect(undo).toHaveBeenCalledTimes(1);
    const late = q.show({ text: "Deleted", undo });
    q.tick(UNDO_TOAST_MS);
    expect(q.undo(late)).toBe(false);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("shows one at a time, and merges a run of the same action into one whose Undo undoes them all (journeys walk 2, V15)", () => {
    const q = createToastQueue();
    const undone: string[] = [];
    q.show({ text: "Created step-wood-1", undo: () => undone.push("1") });
    q.show({ text: "Created step-wood-2", undo: () => undone.push("2") });
    const id = q.show({ text: "Created step-wood-3", undo: () => undone.push("3") });
    expect(q.toasts.value.map((t) => t.text)).toEqual(["Created step-wood-3 · and 2 more"]);
    expect(q.undo(id)).toBe(true);
    expect(undone).toEqual(["3", "2", "1"]);
    // Another action takes the place; its Undo is its own.
    q.show({ text: "Created a", undo: () => undone.push("a") });
    const other = q.show({ text: "Deleted b", undo: () => undone.push("b") });
    expect(q.toasts.value.map((t) => t.text)).toEqual(["Deleted b"]);
    q.undo(other);
    expect(undone.slice(3)).toEqual(["b"]);
  });

  it("holds time while paused, can be dismissed, and a new one takes the place of the one showing", () => {
    const q = createToastQueue();
    const a = q.show({ text: "a", undo() {} });
    q.pause(true);
    q.tick(UNDO_TOAST_MS * 2);
    expect(q.toasts.value).toHaveLength(1);
    q.pause(false);
    q.dismiss(a);
    expect(q.toasts.value).toHaveLength(0);
    const undo = vi.fn();
    const first = q.show({ text: "1", undo });
    for (const t of ["2", "3", "4"]) q.show({ text: t });
    expect(q.toasts.value.map((t) => t.text)).toEqual(["4"]);
    expect(q.undo(first)).toBe(false);
    expect(q.show({ text: "e", kind: "error", undo() {}, undoLabel: "Restore" })).toBeGreaterThan(0);
    expect(q.toasts.value.at(-1)).toMatchObject({ kind: "error", undoLabel: "Restore" });
  });
});

describe("segmented control", () => {
  const options = [{ value: "ear", label: "By ear" }, { value: "eye", label: "By eye" }, { value: "off", label: "Off", disabled: true }];
  it("moves with the arrows (wrapping, skipping disabled), Home and End", () => {
    expect(segmentForKey(options, "ear", "ArrowRight")).toBe("eye");
    expect(segmentForKey(options, "eye", "ArrowRight")).toBe("ear");
    expect(segmentForKey(options, "ear", "ArrowLeft")).toBe("eye");
    expect(segmentForKey(options, "eye", "Home")).toBe("ear");
    expect(segmentForKey(options, "ear", "End")).toBe("eye");
    expect(segmentForKey(options, "ear", "Home")).toBeNull(); // already there
    expect(segmentForKey(options, "ear", "a")).toBeNull();
  });
});

describe("Move to…", () => {
  const folders = ["audio/sfx/cars", "audio/music", "takes"];

  it("lists every folder with its ancestors, as a tree under the project root", () => {
    expect(allFolders(folders)).toEqual(["", "audio", "audio/music", "audio/sfx", "audio/sfx/cars", "takes"]);
    const root = folderTree(folders, "Racer");
    expect(root.name).toBe("Racer");
    expect(root.children.map((c) => c.path)).toEqual(["audio", "takes"]);
    expect(root.children[0].children.map((c) => c.name)).toEqual(["music", "sfx"]);
  });

  it("disables the folder the items are in, and a moved folder with everything inside it", () => {
    const file = [{ path: "audio/sfx/horn.wav", folder: false }];
    expect(whyNotMoveTo("audio/sfx", file)).toMatch(/already/);
    expect(whyNotMoveTo("audio", file)).toBeNull();
    const dir = [{ path: "audio/sfx", folder: true }];
    expect(whyNotMoveTo("audio/sfx", dir)).toMatch(/itself/);
    expect(whyNotMoveTo("audio/sfx/cars", dir)).toMatch(/inside it/);
    expect(whyNotMoveTo("audio", dir)).toMatch(/already/);
    expect(whyNotMoveTo("audio/sfxtra", dir)).toBeNull(); // a sibling whose name only starts the same
    expect(whyNotMoveTo("", dir)).toBeNull();
    const mixed = [{ path: "takes/a.sporesample", folder: false }, { path: "b.sporesample", folder: false }];
    expect(whyNotMoveTo("takes", mixed)).toBeNull(); // one of them moves
    expect(whyNotMoveTo("x", [])).not.toBeNull();
    expect(isCurrentFolder("audio/sfx", file)).toBe(true);
    expect(isCurrentFolder("audio", file)).toBe(false);
    expect(isCurrentFolder("takes", mixed)).toBe(false);
  });

  it("searches folders by path, always listing the top level first", () => {
    expect(searchFolders(folders, "SFX")).toEqual(["", "audio/sfx", "audio/sfx/cars"]);
    expect(searchFolders(folders, "nothing like it")).toEqual([""]);
    expect(searchFolders(folders, "  ")).toHaveLength(6);
  });
});

const ev = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("key combos", () => {
  it("parse and print the platform's way", () => {
    const redo = parseCombo("Mod+Shift+Z")!;
    expect(formatCombo(redo, false)).toBe("Ctrl+Shift+Z");
    expect(formatCombo(redo, true)).toBe("⇧⌘Z");
    expect(formatKeys("Space", false)).toBe("Space");
    expect(formatKeys("F6", false)).toBe("F6");
    expect(formatKeys("Mod++", false)).toBe("Ctrl++");
    expect(parseCombo("Shift")).toBeNull();
    expect(isSingleKey(parseCombo("?")!)).toBe(true);
    expect(isSingleKey(parseCombo("Mod+1")!)).toBe(false);
    expect(isSingleKey(parseCombo("F6")!)).toBe(false);
    expect(isSingleKey(parseCombo("Space")!)).toBe(true);
  });

  it("match events: Mod is Cmd on macOS, Ctrl elsewhere; digits and letters by physical key", () => {
    const one = parseCombo("Mod+1")!;
    expect(matchesCombo(one, ev("1", { ctrlKey: true }), false)).toBe(true);
    expect(matchesCombo(one, ev("1", { metaKey: true }), true)).toBe(true);
    expect(matchesCombo(one, ev("1", { metaKey: true }), false)).toBe(false);
    expect(matchesCombo(one, ev("!", { ctrlKey: true, shiftKey: true, code: "Digit1" }), false)).toBe(false); // Shift isn't in the combo
    const back = parseCombo("Mod+Alt+Z")!;
    expect(matchesCombo(back, ev("Ω", { ctrlKey: true, altKey: true, code: "KeyZ" }), false)).toBe(true);
    expect(matchesCombo(parseCombo("?")!, ev("?", { shiftKey: true }), false)).toBe(true);
    expect(matchesCombo(parseCombo("Space")!, ev(" "), false)).toBe(true);
    expect(matchesCombo(parseCombo("Ctrl+Y")!, ev("y", { ctrlKey: true }), true)).toBe(true);
  });
});

describe("keyboard shortcuts list", () => {
  const groups = [
    { title: "Everywhere", entries: [{ label: "Switch to the Mixer", keys: ["Mod+3"] }, { label: "Keyboard shortcuts", keys: ["?"] }] },
    { title: "Fader", entries: [{ label: "Nudge", keys: ["Up"], off: true }] },
  ];
  it("writes the keys the platform's way and filters by what they do, their group or their keys", () => {
    expect(shownShortcuts(groups, "", true)[0].entries[0].keys).toEqual(["⌘3"]);
    expect(shownShortcuts(groups, "mixer", false).map((g) => g.title)).toEqual(["Everywhere"]);
    expect(shownShortcuts(groups, "fader", false)[0].entries[0]).toEqual({ label: "Nudge", keys: ["↑"], off: true });
    expect(shownShortcuts(groups, "ctrl+3", false)[0].entries.map((e) => e.label)).toEqual(["Switch to the Mixer"]);
    expect(shownShortcuts(groups, "nothing", false)).toEqual([]);
  });
});

describe("History popover", () => {
  const history = (over: Record<string, unknown> = {}) => ({ canUndo: true, canRedo: false, undoLabel: "Move marker", redoLabel: null, undo() {}, redo() {}, ...over });
  it("names the step and keys on each button, and whose history it is", () => {
    const t = historyPopoverText({ history: history({ tree: { states: [], current: 0, saved: 0, jumpTo() {} } }), path: "audio/engine.playlist.json" }, false);
    expect(t.undo).toEqual({ enabled: true, title: "Undo Move marker (Ctrl+Z)" });
    expect(t.redo).toEqual({ enabled: false, title: "Nothing to redo (Ctrl+Shift+Z)" });
    expect(t.heading).toBe("engine.playlist.json · every step, with branches");
    expect(t.tree).toBe(true);
  });
  it("says why there is nothing without an active history, in the host's words", () => {
    const t = historyPopoverText(null, true, "Open a document to undo");
    expect(t.undo.enabled).toBe(false);
    expect(t.undo.title).toBe("Undo (⌘Z)");
    expect(t.heading).toBe("Open a document to undo");
    expect(historyPopoverText({ history: history({ name: "Calibration" }) }, false).heading).toBe("Calibration keeps a short undo list");
  });
});

describe("panel fields' number box", () => {
  const r = { value: -6, min: -96, max: 12, step: 0.5 };
  it("shows its digits without trailing zeros", () => {
    expect(numberBoxText(-6, 2)).toBe("-6");
    expect(numberBoxText(1 / 3, 2)).toBe("0.33");
  });
  it("commits a typed value (a comma reads as a point), clamped; nothing for no change, text or an empty box", () => {
    expect(numberBoxCommit("-3,5", r)).toBe(-3.5);
    expect(numberBoxCommit("40", r)).toBe(12);
    expect(numberBoxCommit("-6", r)).toBeNull();
    expect(numberBoxCommit("loud", r)).toBeNull();
    expect(numberBoxCommit("  ", r)).toBeNull();
  });
  it("steps by its step, ×10 with Shift, clamped", () => {
    expect(numberBoxStep(r, 1, false)).toBe(-5.5);
    expect(numberBoxStep(r, -1, true)).toBe(-11);
    expect(numberBoxStep({ ...r, value: 11.8 }, 1, false)).toBe(12);
    expect(numberBoxStep({ value: 0.1 }, 1, false)).toBe(1.1);
  });
});
