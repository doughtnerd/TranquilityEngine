// ADR 0171/0172 (Pf8; api-and-models §7): the bar slot, rendered with its hooks (`testRender`, no DOM) over a real
// controller and the shared `profilerFlow`. Labels on every control (the test walks the rendered tree), the open
// progress and Cancel, the legend, Open clicking the file input, a chosen file going through X2's `onDropFile`, and no
// colour literals in Pf8's files.
import { readFileSync } from "node:fs";
import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { find, render, type HostNode, type Rendered } from "../../../../editor/testRender";
import { ProfilerController, profilerSlots, type ProfilerDeps, type ProfilerView } from "./ProfilerPanel";
import { ProfilerBar } from "./ProfilerBar";
import { KEY_BINDINGS } from "./profilerKeys";
import { profilerFlow } from "./openSaveFlow";

vi.mock("preact/hooks", () => import("../../../../editor/testRender"));

const deps: ProfilerDeps = {
  capture: { state: "idle", seconds: 0, bytes: 0, truncated: false, start: async () => {}, stop() {}, mark() {}, save: async () => "x" } as unknown as ProfilerDeps["capture"],
  openCapture: () => Promise.reject(new Error("unused")),
  projectAudio: () => undefined,
  liveHost: null,
  trackFactories: [],
  playing: () => false,
};

type Node = HostNode;

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  profilerFlow.reset();
});

/**
 * The bar for `view` over `controller`; `elements()` renders it and lists every host element. The file input's ref gets
 * a stand-in that counts clicks; the bar's root finds no panel around it (`closest` answers null), as outside a panel.
 */
function bar(view: ProfilerView, controller: ProfilerController) {
  const props = { view, controller };
  const clicks = { input: 0 };
  const r = render(() => h(ProfilerBar, props), {
    host: (type) => (type === "input" ? { value: "", click: () => void clicks.input++ } : { closest: () => null }),
  });
  mounted.push(r);
  const elements = (): Node[] => find(r.tree(), () => true);
  return { props, clicks, elements, by: (action: string) => elements().find((e) => e.props["data-action"] === action) };
}

const CONTROLS = new Set(["button", "input", "progress", "canvas", "select", "textarea"]);
const REGIONS = new Set(["toolbar", "region", "status", "alert"]);

describe("accessibility labels", () => {
  const c = new ProfilerController(deps);
  const idle = c.view;
  const opening: ProfilerView = { ...idle, busy: "opening", fileName: "a.mycap" };
  const saving: ProfilerView = { ...idle, busy: "saving" };

  for (const [name, view] of [["idle", idle], ["opening", opening], ["saving", saving]] as const) {
    it(`${name}: every control, list and landmark in the bar has an aria-label`, () => {
      const els = bar(view, c).elements();
      expect(els.length).toBeGreaterThan(8);
      for (const e of els) {
        const role = e.props.role as string | undefined;
        if (CONTROLS.has(e.type) || (role && REGIONS.has(role)) || e.type === "ul" || e.type === "kbd") {
          expect(e.props["aria-label"], `${e.type} ${String(role ?? "")}`).toBeTruthy();
        }
      }
    });
  }

  it("the toolbar carries a label and its buttons name their action", () => {
    const els = bar(idle, c).elements();
    const labels = Object.fromEntries(els.filter((e) => e.type === "button").map((e) => [e.props["data-action"] as string, e.props["aria-label"] as string]));
    expect(labels).toEqual({ record: "Record a capture", stop: "Stop recording", save: "Save the capture", open: "Open a capture file" });
    expect(els.find((e) => e.props.role === "toolbar")!.props["aria-label"]).toBe("Capture");
  });
});

describe("the bar's open and save experience", () => {
  const c = new ProfilerController(deps);

  it("an open shows a Cancel button and a labelled progress bar that follows the reports; idle shows neither", () => {
    const b = bar({ ...c.view, busy: "opening", fileName: "a.mycap" }, c);
    expect(b.by("cancel")).toBeDefined();
    profilerFlow.progress("inflate", 1, 2); // half of the first half
    const els = b.elements();
    const p = els.find((e) => e.type === "progress")!;
    expect(p.props.value).toBe(0.25);
    expect(p.props["aria-label"]).toBe("Open progress");
    expect(els.find((e) => e.props.role === "status")!.props.children).toBe("Unpacking a.mycap 25%");
    profilerFlow.reset();
    const idle = bar(c.view, c).elements();
    expect(idle.some((e) => e.props["data-action"] === "cancel" || e.type === "progress")).toBe(false);
  });

  it("an open before its first report is an indeterminate bar (no value); a save is one too, labelled as a save", () => {
    const open = bar({ ...c.view, busy: "opening" }, c).elements();
    expect("value" in open.find((e) => e.type === "progress")!.props).toBe(false);
    const save = bar({ ...c.view, busy: "saving" }, c).elements();
    const p = save.find((e) => e.type === "progress")!;
    expect(p.props["aria-label"]).toBe("Save progress");
    expect("value" in p.props).toBe(false);
    expect(save.some((e) => e.props["data-action"] === "cancel")).toBe(false);
  });

  it("Open, Record and Save are off while busy; Cancel cancels the flow and the open; Open clicks the file input", () => {
    const cancelOpen = vi.spyOn(c, "cancelOpen");
    const busy = bar({ ...c.view, busy: "opening" }, c);
    expect(busy.by("open")!.props.disabled).toBe(true);
    expect(busy.by("record")!.props.disabled).toBe(true);
    expect(busy.by("save")!.props.disabled).toBe(true);
    expect(profilerFlow.state.phase).toBe("running");
    (busy.by("cancel")!.props.onClick as () => void)();
    expect(cancelOpen).toHaveBeenCalledTimes(1);
    expect(profilerFlow.state.phase).toBe("cancelled");
    cancelOpen.mockRestore();
    const idle = bar(c.view, c);
    expect(idle.by("open")!.props.disabled).toBe(false);
    (idle.by("open")!.props.onClick as () => void)();
    expect(idle.clicks.input).toBe(1);
  });

  it("the status line shows the flow's text in a polite live region", () => {
    const els = bar({ ...c.view, flowError: "disk full" }, c).elements();
    const s = els.find((e) => e.props["aria-live"] === "polite")!;
    expect(s.props.children).toBe("disk full");
    expect(s.props["data-severity"]).toBe("error");
  });

  it("the legend lists every key with its label", () => {
    const items = bar(c.view, c).elements().filter((e) => e.type === "li");
    expect(items.map((e) => e.props["data-key"])).toEqual(KEY_BINDINGS.map((b) => b.id));
  });

  it("a chosen file clears the input, resets the last outcome and goes through profilerSlots.onDropFile (X2's route)", () => {
    const seen: string[] = [];
    const original = profilerSlots.onDropFile;
    profilerSlots.onDropFile = (_c, f) => void seen.push(f.name);
    try {
      profilerFlow.begin("save");
      profilerFlow.fail();
      const input = bar(c.view, c).elements().find((e) => e.type === "input")!;
      const el = { files: [{ name: "a.mycap" }], value: "C:\\a.mycap" };
      (input.props.onChange as (e: unknown) => void)({ currentTarget: el });
      expect(el.value).toBe("");
      expect(seen).toEqual(["a.mycap"]);
      expect(profilerFlow.state.phase).toBe("idle");
      (input.props.onChange as (e: unknown) => void)({ currentTarget: { files: [], value: "" } });
      expect(seen).toEqual(["a.mycap"]); // no file chosen: nothing routed
    } finally {
      profilerSlots.onDropFile = original;
    }
  });
});

describe("theme tokens only", () => {
  const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/;
  for (const file of ["openSaveFlow.css", "openSaveFlow.ts", "ProfilerBar.tsx", "ProfilerBanners.tsx", "profilerKeys.ts"]) {
    it(`${file} has no colour literal`, () => {
      const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(COLOUR.test(text)).toBe(false);
    });
  }
  it("the stylesheet reads its colours from var(--token)", () => {
    const css = readFileSync(new URL("./openSaveFlow.css", import.meta.url), "utf8");
    expect(css).toMatch(/var\(--(accent|danger|muted|border|panel|text)\)/);
  });
});
