// ADR 0171/0172 (Pf8; api-and-models §7): the bar slot's tree. Labels on every control (the test walks the vnode tree),
// the open progress and Cancel, the legend, Open through X2's `onDropFile`, and no colour literals in Pf8's files.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ComponentChild, VNode } from "preact";
import { ProfilerController, profilerSlots, type ProfilerDeps, type ProfilerView } from "./ProfilerPanel";
import { BarView, chooseFile, flowInput, type BarViewProps } from "./ProfilerBar";
import { KEY_BINDINGS } from "./profilerKeys";
import { OpenSaveFlow, describeFlow } from "./openSaveFlow";

const deps: ProfilerDeps = {
  capture: { state: "idle", seconds: 0, bytes: 0, truncated: false, start: async () => {}, stop() {}, mark() {}, save: async () => "x" } as unknown as ProfilerDeps["capture"],
  openCapture: () => Promise.reject(new Error("unused")),
  projectAudio: () => undefined,
  liveHost: null,
  trackFactories: [],
  playing: () => false,
};

type Node = VNode<Record<string, unknown>>;

/** Every intrinsic element in a vnode tree. */
function elements(n: ComponentChild): Node[] {
  if (n === null || n === undefined || typeof n !== "object") return [];
  if (Array.isArray(n)) return n.flatMap(elements);
  const v = n as Node;
  const out: Node[] = typeof v.type === "string" ? [v] : [];
  return out.concat(elements(v.props?.children as ComponentChild));
}

function props(view: ProfilerView, over: Partial<BarViewProps> = {}): BarViewProps {
  const flow = new OpenSaveFlow();
  return {
    view,
    status: describeFlow(flow.state, flowInput(view)),
    onRecord: () => {}, onStop: () => {}, onSave: () => {}, onOpen: () => {}, onCancel: () => {}, onFile: () => {},
    ...over,
  };
}

const CONTROLS = new Set(["button", "input", "progress", "canvas", "select", "textarea"]);
const REGIONS = new Set(["toolbar", "region", "status", "alert"]);

describe("accessibility labels", () => {
  const c = new ProfilerController(deps);
  const idle = c.view;
  const opening: ProfilerView = { ...idle, busy: "opening", fileName: "a.mycap" };
  const saving: ProfilerView = { ...idle, busy: "saving" };

  for (const [name, view, flowState] of [["idle", idle, null], ["opening", opening, "open"], ["saving", saving, "save"]] as const) {
    it(`${name}: every control, list and landmark in the bar has an aria-label`, () => {
      const flow = new OpenSaveFlow();
      if (flowState) flow.begin(flowState, "a.mycap");
      const tree = BarView(props(view, { status: describeFlow(flow.state, flowInput(view)) }));
      const els = elements(tree);
      expect(els.length).toBeGreaterThan(8);
      for (const e of els) {
        const role = e.props.role as string | undefined;
        if (CONTROLS.has(e.type as string) || (role && REGIONS.has(role)) || e.type === "ul" || e.type === "kbd") {
          expect(e.props["aria-label"], `${String(e.type)} ${String(role ?? "")}`).toBeTruthy();
        }
      }
    });
  }

  it("the toolbar carries a label and its buttons name their action", () => {
    const els = elements(BarView(props(idle)));
    const labels = Object.fromEntries(els.filter((e) => e.type === "button").map((e) => [e.props["data-action"] as string, e.props["aria-label"] as string]));
    expect(labels).toEqual({ record: "Record a capture", stop: "Stop recording", save: "Save the capture", open: "Open a capture file" });
    expect(els.find((e) => e.props.role === "toolbar")!.props["aria-label"]).toBe("Capture");
  });
});

describe("the bar's open and save experience", () => {
  const c = new ProfilerController(deps);

  it("an open shows a Cancel button and a labelled progress bar; idle shows neither", () => {
    const opening = elements(BarView(props({ ...c.view, busy: "opening", fileName: "a.mycap" }, { status: { phase: "running", kind: "open", text: "Unpacking a.mycap 25%", fraction: 0.25, cancellable: true, severity: "info" } })));
    expect(opening.some((e) => e.props["data-action"] === "cancel")).toBe(true);
    const p = opening.find((e) => e.type === "progress")!;
    expect(p.props.value).toBe(0.25);
    expect(p.props["aria-label"]).toBe("Open progress");
    const idle = elements(BarView(props(c.view)));
    expect(idle.some((e) => e.props["data-action"] === "cancel" || e.type === "progress")).toBe(false);
  });

  it("an open before its first report is an indeterminate bar (no value); a save is one too, labelled as a save", () => {
    const open = elements(BarView(props({ ...c.view, busy: "opening" }, { status: { phase: "running", kind: "open", text: "Opening", fraction: null, cancellable: true, severity: "info" } })));
    expect("value" in open.find((e) => e.type === "progress")!.props).toBe(false);
    const save = elements(BarView(props({ ...c.view, busy: "saving" }, { status: { phase: "running", kind: "save", text: "Saving", fraction: null, cancellable: false, severity: "info" } })));
    const p = save.find((e) => e.type === "progress")!;
    expect(p.props["aria-label"]).toBe("Save progress");
    expect("value" in p.props).toBe(false);
    expect(save.some((e) => e.props["data-action"] === "cancel")).toBe(false);
  });

  it("Open, Record and Save are off while busy; Cancel and Open call their handlers", () => {
    const onCancel = vi.fn();
    const onOpen = vi.fn();
    const busy = elements(BarView(props({ ...c.view, busy: "opening" }, { onCancel, onOpen })));
    const by = (a: string) => busy.find((e) => e.props["data-action"] === a)!;
    expect(by("open").props.disabled).toBe(true);
    expect(by("record").props.disabled).toBe(true);
    expect(by("save").props.disabled).toBe(true);
    (by("cancel").props.onClick as () => void)();
    expect(onCancel).toHaveBeenCalledTimes(1);
    const open = elements(BarView(props(c.view, { onOpen }))).find((e) => e.props["data-action"] === "open")!;
    expect(open.props.disabled).toBe(false);
    (open.props.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("the status line shows the flow's text in a polite live region", () => {
    const els = elements(BarView(props(c.view, { status: { phase: "failed", kind: "save", text: "disk full", fraction: undefined, cancellable: false, severity: "error" } })));
    const s = els.find((e) => e.props["aria-live"] === "polite")!;
    expect(s.props.children).toBe("disk full");
    expect(s.props["data-severity"]).toBe("error");
  });

  it("the legend lists every key with its label", () => {
    const items = elements(BarView(props(c.view))).filter((e) => e.type === "li");
    expect(items.map((e) => e.props["data-key"])).toEqual(KEY_BINDINGS.map((b) => b.id));
  });

  it("choosing a file clears the input and goes through profilerSlots.onDropFile (X2's route)", () => {
    const seen: string[] = [];
    const original = profilerSlots.onDropFile;
    profilerSlots.onDropFile = (_c, f) => void seen.push(f.name);
    try {
      const input = { value: "C:\\a.mycap" };
      chooseFile(c, { name: "a.mycap", arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File, input, new OpenSaveFlow());
      expect(input.value).toBe("");
      expect(seen).toEqual(["a.mycap"]);
    } finally {
      profilerSlots.onDropFile = original;
    }
  });

  it("the file input routes its chosen file to onFile", () => {
    const onFile = vi.fn();
    const input = elements(BarView(props(c.view, { onFile }))).find((e) => e.type === "input")!;
    const f = { name: "b.mycap" } as File;
    const el = { files: [f] } as unknown as HTMLInputElement;
    (input.props.onChange as (e: unknown) => void)({ currentTarget: el });
    expect(onFile).toHaveBeenCalledWith(f, el);
    onFile.mockClear();
    (input.props.onChange as (e: unknown) => void)({ currentTarget: { files: [] } });
    expect(onFile).not.toHaveBeenCalled();
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
