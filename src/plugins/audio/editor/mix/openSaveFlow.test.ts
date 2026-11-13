// ADR 0171/0172 (Pf8; api-and-models §7, §5): the words for every CaptureError code, the open/save flow model, and the
// banners slot. A message test per code in `CAPTURE_ERROR_CODES`; the version codes are read from the real reader so
// both versions are asserted on what the reader writes. No assertion reads a wall clock.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { CAPTURE_ERROR_CODES, CaptureError, readCaptureHeader } from "../../runtime/capture/format";
import { sampleCapture } from "../../runtime/capture/testSupport";
import { ProfilerController, profilerBanners, type ProfilerBanner, type ProfilerDeps } from "./ProfilerPanel";
import { ProfilerBanners, bannerText } from "./ProfilerBanners";
import {
  CAPTURE_ERROR_HEADLINES, OPEN_ROUTE_HEADLINES, OpenSaveFlow, captureErrorMessage, describeFlow, headlineOf, openFraction, parseErrorBanner,
  syncFlow, type FlowViewInput,
} from "./openSaveFlow";

/** The reader's refusal of `bytes`' header. */
function readerError(bytes: Uint8Array): CaptureError {
  try {
    readCaptureHeader(bytes);
  } catch (e) {
    if (e instanceof CaptureError) return e;
    throw e;
  }
  throw new Error("the reader accepted the header");
}

const plain = (e: CaptureError): string => e.message.slice(`${e.code} at ${e.offset}: `.length);

describe("a message per CaptureError code", () => {
  for (const code of CAPTURE_ERROR_CODES) {
    it(`${code}: a headline, the code and the reader's detail`, () => {
      const head = CAPTURE_ERROR_HEADLINES[code];
      expect(head.length).toBeGreaterThan(10);
      expect(head.endsWith(".")).toBe(true);
      expect(headlineOf(code)).toBe(head);
      const msg = captureErrorMessage(code, "detail text at 42");
      expect(msg).toBe(`${head} (${code}) detail text at 42`);
    });
  }

  it("the table has no extra codes and no two codes share a headline", () => {
    expect(Object.keys(CAPTURE_ERROR_HEADLINES).sort()).toEqual([...CAPTURE_ERROR_CODES].sort());
    const heads = Object.values(CAPTURE_ERROR_HEADLINES);
    expect(new Set(heads).size).toBe(heads.length);
  });

  it("the route's own codes and an unknown code still read well", () => {
    expect(captureErrorMessage("notCapture", "x.txt is not a capture file")).toBe(`${OPEN_ROUTE_HEADLINES.notCapture} (notCapture) x.txt is not a capture file`);
    expect(captureErrorMessage("open", "disk gone")).toBe(`${OPEN_ROUTE_HEADLINES.open} (open) disk gone`);
    expect(captureErrorMessage("fromTheFuture", "huh")).toBe("(fromTheFuture) huh");
    expect(captureErrorMessage("badMagic", "")).toBe(`${CAPTURE_ERROR_HEADLINES.badMagic} (badMagic)`);
  });

  it("newerFormat and olderFormat name this build's format and the file's", () => {
    const bytes = new Uint8Array(sampleCapture());
    const header = readCaptureHeader(bytes);
    const mine = header.format;
    const newer = bytes.slice();
    newer[8] = mine + 1;
    const e1 = readerError(newer);
    expect(e1.code).toBe("newerFormat");
    const m1 = captureErrorMessage(e1.code, plain(e1));
    expect(m1).toContain(`format ${mine + 1}`);
    expect(m1).toContain(`build's ${mine}`);
    expect(m1).toContain("(newerFormat)");
    const older = bytes.slice();
    older[8] = mine - 1;
    const e2 = readerError(older);
    expect(e2.code).toBe("olderFormat");
    const m2 = captureErrorMessage(e2.code, plain(e2));
    expect(m2).toContain(`format ${mine - 1}`);
    expect(m2).toContain(`build's ${mine}`);
    expect(m2).toContain("re-record");
  });

  it("wireMismatch names the file's ABI and this build's, and says to re-record", () => {
    const b = new Uint8Array(sampleCapture());
    for (let i = 12; i < 28; i++) b[i] = b[i]! ^ 0xff;
    const e = readerError(b);
    expect(e.code).toBe("wireMismatch");
    const m = captureErrorMessage(e.code, plain(e));
    expect(m).toMatch(/recorded with audio ABI \S+ \(wire [0-9a-f]{32}\); this build is ABI \S+ \(wire [0-9a-f]{32}\): re-record with this build/);
    expect(m).toContain("(wireMismatch)");
  });
});

describe("the banners slot", () => {
  const deps = (openCapture: ProfilerDeps["openCapture"]): ProfilerDeps => ({
    capture: { state: "idle", seconds: 0, bytes: 0, truncated: false, start: async () => {}, stop() {}, mark() {}, save: async () => "x" } as unknown as ProfilerDeps["capture"],
    openCapture,
    projectAudio: () => undefined,
    liveHost: null,
    trackFactories: [],
    playing: () => false,
  });

  for (const code of CAPTURE_ERROR_CODES) {
    it(`${code}: an opened file shows the headline and the code in its banner`, async () => {
      const c = new ProfilerController(deps(() => Promise.reject(new CaptureError(code, 7, "the detail"))));
      expect(await c.openFile("bad.mycap", new ArrayBuffer(1))).toBe(false);
      const banner = c.view.banners[0]!;
      const { text, code: shown } = bannerText(banner);
      expect(shown).toBe(code);
      expect(text).toBe(`Can't open bad.mycap: ${CAPTURE_ERROR_HEADLINES[code]} (${code}) the detail`);
      c.dispose();
    });
  }

  it("a non-CaptureError failure and a refused file keep their words", async () => {
    const c = new ProfilerController(deps(() => Promise.reject(new Error("worker died"))));
    await c.openFile("a.mycap", new ArrayBuffer(1));
    expect(bannerText(c.view.banners[0]!).text).toBe(`Can't open a.mycap: ${OPEN_ROUTE_HEADLINES.open} (open) worker died`);
    c.refuseFile("n.txt", "notCapture", "n.txt is not a capture file");
    expect(bannerText(c.view.banners[0]!).text).toBe(`Can't open n.txt: ${OPEN_ROUTE_HEADLINES.notCapture} (notCapture) n.txt is not a capture file`);
    c.dispose();
  });

  it("other banners keep the controller's text; errors are alerts, the rest status", () => {
    const list: ProfilerBanner[] = [
      { id: "viewing", severity: "info", text: "Viewing, not replaying" },
      { id: "error", severity: "error", text: "Can't open q.mycap: badSeq: sequence 5 after 9" },
    ];
    const tree = ProfilerBanners({ banners: list }) as VNode<{ children: VNode<Record<string, unknown>>[]; "aria-label": string; role: string }>;
    expect(tree.props.role).toBe("region");
    expect(tree.props["aria-label"]).toBe("Profiler notices");
    const ps = tree.props.children;
    expect(ps[0]!.props.role).toBe("status");
    expect(ps[0]!.props.children).toBe("Viewing, not replaying");
    expect(ps[1]!.props.role).toBe("alert");
    expect(ps[1]!.props["data-code"]).toBe("badSeq");
    expect(ps[1]!.props.children).toContain("(badSeq) sequence 5 after 9");
  });

  it("parseErrorBanner reads what profilerBanners writes, wire mismatch included", () => {
    const e = profilerBanners({ source: null, projectAudio: undefined, error: { code: "badLength", message: "m: n" }, fileName: "f: g.mycap" });
    expect(parseErrorBanner(e[0]!.id, e[0]!.text)).toEqual({ file: "f: g.mycap", code: "badLength", detail: "m: n" });
    const w = profilerBanners({ source: null, projectAudio: undefined, error: { code: "wireMismatch", message: "ABI a; this build is ABI b" }, fileName: "w.mycap" });
    expect(parseErrorBanner(w[0]!.id, w[0]!.text)).toEqual({ file: "w.mycap", code: "wireMismatch", detail: "ABI a; this build is ABI b" });
    expect(parseErrorBanner("viewing", "Viewing, not replaying")).toBeNull();
    expect(parseErrorBanner("error", "Can't open z: zzz: nope")).toBeNull();
  });
});

describe("the open and save flow", () => {
  const idle: FlowViewInput = { busy: null, flowError: null, savedAs: null, fileName: null, origin: "none", openRefused: false };

  it("open: begins, reports progress as a rising fraction across both steps, then finishes", () => {
    const f = new OpenSaveFlow();
    f.begin("open", "a.mycap");
    expect(f.state).toMatchObject({ kind: "open", phase: "running", fraction: null });
    f.progress("inflate", 50, 100);
    expect(f.state.fraction).toBe(0.25);
    f.progress("inflate", 100, 100);
    expect(f.state.fraction).toBe(0.5);
    f.progress("records", 10, 40);
    expect(f.state.fraction).toBe(0.625);
    f.progress("records", 5, 40); // never backwards
    expect(f.state.fraction).toBe(0.625);
    f.finish();
    expect(f.state).toMatchObject({ phase: "done", fraction: 1 });
  });

  it("openFraction clamps and survives a zero total", () => {
    expect(openFraction("inflate", 5, 0)).toBe(0);
    expect(openFraction("records", 9, 3)).toBe(1);
    expect(openFraction("records", -1, 3)).toBe(0.5);
  });

  it("cancel: a running open becomes cancelled, a late report and finish change nothing, and the bar says the previous capture stays", () => {
    const f = new OpenSaveFlow();
    f.begin("open", "a.mycap");
    f.cancel();
    expect(f.state.phase).toBe("cancelled");
    f.progress("records", 1, 2);
    f.finish();
    expect(f.state.phase).toBe("cancelled");
    const s = describeFlow(f.state, { ...idle, origin: "file", fileName: "prev.mycap" });
    expect(s).toMatchObject({ phase: "cancelled", cancellable: false });
    expect(s.text).toBe("Open cancelled. prev.mycap stays open.");
    expect(describeFlow(f.state, idle).text).toBe("Open cancelled. The previous capture is unchanged.");
  });

  it("cancel with nothing running does nothing", () => {
    const f = new OpenSaveFlow();
    f.cancel();
    expect(f.state.phase).toBe("idle");
  });

  it("running open: text with the step and percent, a determinate fraction, Cancel offered", () => {
    const f = new OpenSaveFlow();
    f.begin("open", "a.mycap");
    const v: FlowViewInput = { ...idle, busy: "opening", fileName: "a.mycap" };
    expect(describeFlow(f.state, v)).toMatchObject({ text: "Opening a.mycap", fraction: null, cancellable: true });
    f.progress("inflate", 1, 2);
    expect(describeFlow(f.state, v)).toMatchObject({ text: "Unpacking a.mycap 25%", fraction: 0.25, cancellable: true });
    f.progress("records", 3, 4);
    expect(describeFlow(f.state, v).text).toBe("Reading records a.mycap 88%");
  });

  it("save: running without a fraction (the recorder reports none), then the saved name; a failure shows its message", () => {
    const f = new OpenSaveFlow();
    f.begin("save");
    f.progress("records", 1, 2); // an open's report is ignored during a save
    expect(f.state.fraction).toBeNull();
    expect(describeFlow(f.state, { ...idle, busy: "saving" })).toMatchObject({ phase: "running", kind: "save", text: "Saving", fraction: null, cancellable: false });
    expect(describeFlow(f.state, { ...idle, savedAs: "capture-1.mycap" })).toMatchObject({ phase: "done", text: "Saved capture-1.mycap" });
    expect(describeFlow(f.state, { ...idle, flowError: "disk full" })).toMatchObject({ phase: "failed", text: "disk full", severity: "error" });
  });

  it("a refused open points at the notice; an open file shows its name; nothing shows nothing", () => {
    const f = new OpenSaveFlow();
    expect(describeFlow(f.state, { ...idle, openRefused: true, fileName: "x.mycap" })).toMatchObject({ phase: "failed", text: "Couldn't open x.mycap; see the notice below.", severity: "error" });
    expect(describeFlow(f.state, { ...idle, origin: "file", fileName: "x.mycap" }).text).toBe("x.mycap");
    expect(describeFlow(f.state, idle)).toMatchObject({ phase: "idle", text: "", fraction: undefined });
  });

  it("syncFlow follows the controller's busy: begin, finish, and fail on a refusal or an error", () => {
    const f = new OpenSaveFlow();
    syncFlow(f, null, { ...idle, busy: "opening", fileName: "a.mycap" });
    expect(f.state).toMatchObject({ kind: "open", phase: "running", name: "a.mycap" });
    syncFlow(f, "opening", { ...idle, openRefused: true });
    expect(f.state.phase).toBe("failed");
    syncFlow(f, null, { ...idle, busy: "saving" });
    expect(f.state).toMatchObject({ kind: "save", phase: "running" });
    syncFlow(f, "saving", { ...idle, flowError: "no" });
    expect(f.state.phase).toBe("failed");
    syncFlow(f, null, { ...idle, busy: "saving" });
    syncFlow(f, "saving", { ...idle, savedAs: "s.mycap" });
    expect(f.state.phase).toBe("done");
    syncFlow(f, null, { ...idle, busy: "opening" });
    f.cancel();
    syncFlow(f, "opening", idle); // the controller's cancel clears busy: the cancel stays
    expect(f.state.phase).toBe("cancelled");
  });

  it("subscribers hear each change and stop when they unsubscribe", () => {
    const f = new OpenSaveFlow();
    let n = 0;
    const off = f.subscribe(() => n++);
    f.begin("open");
    f.progress("inflate", 1, 2);
    expect(n).toBe(2);
    off();
    f.finish();
    expect(n).toBe(2);
  });
});
