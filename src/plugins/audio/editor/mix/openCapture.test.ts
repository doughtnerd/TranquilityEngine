// ADR 0171/0172 (X2; api-and-models §7): opening a capture from a file. Each message is asserted on a fixture capture read
// through the real `CaptureSource` and the capture Worker's real handler: the wire mismatch naming both ABI versions, the
// project mismatch warning, truncated (the ring wrapped, and a file cut short), a file that isn't a capture, and the
// decode caps (a header past the cap, a deflate bomb, a file too big to read). Drop and Open share one route, the slot
// `installOpenCapture` fills; a drop on the rendered panel and the bar's file input reaching it are ProfilerPanel.stories.tsx.
// Nothing here reads a wall clock.
import { describe, expect, it, vi } from "vitest";
import { deflateRawSync } from "node:zlib";
import { CAPTURE_ABI_VERSION, CAPTURE_FLAG_COMPRESSED, CAPTURE_HEADER_BYTES, CAPTURE_MAX_UNCOMPRESSED_BYTES, CAPTURE_META_MAX_BYTES, assembleCapture } from "../../runtime/capture/format";
import { SAMPLE_HEADER, SAMPLE_META, sampleCapture } from "../../runtime/capture/testSupport";
import type { AudioCapture } from "../../runtime/capture/capture";
import { CaptureSource, type CaptureWorkerLike, type ProfileSource } from "./profilerSource";
import { createCaptureWorkerHandler, type CaptureRequest, type CaptureResponse } from "../../runtime/capture/worker";
import { ProfilerController, profilerSlots, type ProfilerDeps, type ProfilerSlots } from "./ProfilerPanel";
import { OPEN_REFUSALS, installOpenCapture, type CaptureFileLike } from "./openCapture";

// The banners' words.
const BANNER_TEXT = {
  viewing: "Viewing, not replaying",
  truncated: "Truncated: the ring wrapped. This capture starts at a later keyframe, not at Play.",
  projectMismatch: "This capture was recorded with a different audio section than the open project's. It is shown as recorded.",
  babylon: "Babylon fallback: main-side events and keyframes only. The CPU, underrun and loudness tracks are absent.",
} as const;

function inProcessWorker(): CaptureWorkerLike {
  const w: CaptureWorkerLike & { dead: boolean } = {
    onmessage: null,
    onerror: null,
    dead: false,
    postMessage(message: CaptureRequest, transfer) {
      const copy = structuredClone(message, { transfer: transfer as Transferable[] });
      setTimeout(() => { if (!w.dead) void handler.handle(copy); }, 0);
    },
    terminate() {
      w.dead = true;
    },
  };
  const handler = createCaptureWorkerHandler({
    post: (r: CaptureResponse, transfer) => {
      const copy = structuredClone(r, { transfer: transfer as Transferable[] });
      setTimeout(() => { if (!w.dead) w.onmessage?.({ data: copy }); }, 0);
    },
  });
  return w;
}

/** The largest file the route reads: the header, a META chunk and an uncompressed payload at its cap. */
const OPEN_MAX_FILE_BYTES = CAPTURE_HEADER_BYTES + CAPTURE_META_MAX_BYTES + CAPTURE_MAX_UNCOMPRESSED_BYTES;

/**
 * Hand `file` to the panel's drop slot as `installOpenCapture` fills it (the drop and the bar's Open both call it), and
 * resolve whether a capture is now open: the controller's `openBlob` answer, or false when the route refused it unread.
 */
async function routeCaptureFile(c: Pick<ProfilerController, "openBlob" | "refuseFile">, file: CaptureFileLike): Promise<boolean> {
  const slots: Pick<ProfilerSlots, "onDropFile"> = { onDropFile: () => {} };
  installOpenCapture(slots);
  let opened: Promise<boolean> = Promise.resolve(false);
  const opener = { openBlob: (f: CaptureFileLike) => (opened = c.openBlob(f)), refuseFile: (name: string, code: string, message: string) => c.refuseFile(name, code, message) };
  slots.onDropFile(opener as unknown as ProfilerController, file);
  return opened;
}

/** Whether the route takes a file by its name (rather than refusing it unread as not a capture). */
async function isCaptureFileName(name: string): Promise<boolean> {
  let taken = false;
  await routeCaptureFile({ openBlob: async () => (taken = true), refuseFile() {} }, { name, arrayBuffer: async () => new ArrayBuffer(0) });
  return taken;
}

const PROJECT_AUDIO = SAMPLE_META.audio;
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;
const fileOf = (name: string, bytes: ArrayBuffer, size?: number): CaptureFileLike => ({ name, ...(size !== undefined ? { size } : {}), arrayBuffer: async () => bytes });

const good = (init: { truncated?: boolean } = {}, audio: unknown = PROJECT_AUDIO): ArrayBuffer =>
  buf(assembleCapture({ ...SAMPLE_HEADER, ...init }, { ...SAMPLE_META, audio }, [], { index: true }));

/** The sample with another wire hash (bytes 12..27) and, when given, another ABI word (bytes 28..31). */
function otherWire(abi?: number): ArrayBuffer {
  const b = new Uint8Array(sampleCapture());
  for (let i = 12; i < 28; i++) b[i] = b[i]! ^ 0xff;
  if (abi !== undefined) new DataView(b.buffer).setUint32(28, abi, true);
  return buf(b);
}

/** A deflate bomb: the sample's header (small `uncompressedBytes`) over a stream that inflates to `inflatedBytes`. */
function deflateBomb(inflatedBytes: number): ArrayBuffer {
  const plain = sampleCapture();
  const z = deflateRawSync(new Uint8Array(inflatedBytes));
  const out = new Uint8Array(CAPTURE_HEADER_BYTES + z.byteLength);
  out.set(plain.subarray(0, CAPTURE_HEADER_BYTES));
  out.set(z, CAPTURE_HEADER_BYTES);
  const v = new DataView(out.buffer);
  v.setUint16(10, v.getUint16(10, true) | CAPTURE_FLAG_COMPRESSED, true);
  return buf(out);
}

const opened: ProfileSource[] = [];
const realOpen = async (bytes: ArrayBuffer): Promise<ProfileSource> => {
  const s = await CaptureSource.openFile(bytes, { worker: inProcessWorker() });
  opened.push(s);
  return s;
};

const idle: AudioCapture = { state: "idle", seconds: 0, bytes: 0, truncated: false, start: async () => {}, stop() {}, mark() {}, save: async () => "x.mycap" };
function deps(over: Partial<ProfilerDeps> = {}): ProfilerDeps {
  return { capture: idle, openCapture: realOpen, projectAudio: () => PROJECT_AUDIO, liveHost: null, trackFactories: [], playing: () => false, ...over } as ProfilerDeps;
}
const ids = (c: ProfilerController): string[] => c.view.banners.map((b) => b.id);
const textOf = (c: ProfilerController, id: string): string => c.view.banners.find((b) => b.id === id)?.text ?? "";

describe("each message on a fixture capture", () => {
  it("a capture of this project opens with only the viewing note", async () => {
    const c = new ProfilerController(deps());
    expect(await routeCaptureFile(c, fileOf("ok.mycap", good()))).toBe(true);
    expect(ids(c)).toEqual(["viewing"]);
    c.dispose();
  });

  it("another wire is refused naming both ABI versions (recorded 3.1, this build's) and the wire hashes", async () => {
    const c = new ProfilerController(deps());
    expect(await routeCaptureFile(c, fileOf("old.mycap", otherWire(0x301)))).toBe(false);
    expect(c.view.source).toBeNull();
    expect(ids(c)).toEqual(["wireMismatch"]);
    const text = textOf(c, "wireMismatch");
    const mine = `${CAPTURE_ABI_VERSION >>> 8}.${CAPTURE_ABI_VERSION & 0xff}`;
    expect(text).toContain("Can't open old.mycap");
    expect(text).toContain("recorded with audio ABI 3.1");
    expect(text).toContain(`this build is ABI ${mine}`);
    expect(text).toMatch(/wire [0-9a-f]{32}\).*wire [0-9a-f]{32}\): re-record with this build$/);
    c.dispose();
  });

  it("a capture from another project opens with the project mismatch warning", async () => {
    const c = new ProfilerController(deps({ projectAudio: () => ({ buses: [{ name: "Other" }] }) }));
    expect(await routeCaptureFile(c, fileOf("other.mycap", good()))).toBe(true);
    expect(c.view.source).not.toBeNull();
    expect(ids(c)).toEqual(["projectMismatch", "viewing"]);
    expect(textOf(c, "projectMismatch")).toBe(BANNER_TEXT.projectMismatch);
    c.dispose();
  });

  it("a capture whose ring wrapped opens with the truncated banner", async () => {
    const c = new ProfilerController(deps());
    expect(await routeCaptureFile(c, fileOf("t.mycap", good({ truncated: true })))).toBe(true);
    expect(ids(c)).toEqual(["truncated", "viewing"]);
    expect(textOf(c, "truncated")).toMatch(/^Truncated: the ring wrapped/);
    c.dispose();
  });

  it("a file cut short is an error banner naming its code, never a partial profile", async () => {
    const whole = new Uint8Array(sampleCapture());
    const c = new ProfilerController(deps());
    expect(await routeCaptureFile(c, fileOf("cut.mycap", buf(whole.subarray(0, whole.byteLength - 7))))).toBe(false);
    expect(c.view.source).toBeNull();
    expect(ids(c)).toEqual(["error"]);
    expect(textOf(c, "error")).toMatch(/^Can't open cut\.mycap: [a-zA-Z]+: /);
    c.dispose();
  });

  it("a file that isn't a capture: a wrong extension is refused unread, a .mycap of other bytes is badMagic", async () => {
    const read = vi.fn(async () => good());
    const c = new ProfilerController(deps());
    expect(await routeCaptureFile(c, { name: "notes.txt", arrayBuffer: read })).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(ids(c)).toEqual(["error"]);
    expect(textOf(c, "error")).toBe(`Can't open notes.txt: notCapture: ${OPEN_REFUSALS.notCapture("notes.txt")}`);
    expect(await routeCaptureFile(c, fileOf("fake.mycap", new TextEncoder().encode("this is not a capture file at all, just text".repeat(4)).buffer as ArrayBuffer))).toBe(false);
    expect(textOf(c, "error")).toContain("badMagic");
    expect(await routeCaptureFile(c, fileOf("empty.mycap", new ArrayBuffer(0)))).toBe(false);
    expect(textOf(c, "error")).toContain("badMagic");
    c.dispose();
  });

  it("a refused file leaves the capture that was open open", async () => {
    const c = new ProfilerController(deps());
    await routeCaptureFile(c, fileOf("a.mycap", good()));
    const before = c.view.source;
    await routeCaptureFile(c, fileOf("b.txt", new ArrayBuffer(0)));
    expect(c.view.source).toBe(before);
    expect(c.view.openName).toBe("a.mycap"); // the status keeps naming the capture that is open
    expect(ids(c)).toContain("error");
    c.dispose();
  });
});

describe("the decode caps refuse a bomb (security bounds, not raised)", () => {
  it("a header declaring more than the cap uncompressed is tooLarge, before inflating", async () => {
    const b = new Uint8Array(sampleCapture());
    new DataView(b.buffer).setUint32(68, CAPTURE_MAX_UNCOMPRESSED_BYTES + 1, true);
    const c = new ProfilerController(deps());
    expect(await routeCaptureFile(c, fileOf("big.mycap", buf(b)))).toBe(false);
    expect(textOf(c, "error")).toContain("tooLarge");
    expect(c.view.source).toBeNull();
    c.dispose();
  });

  it("a deflate stream that inflates past its header's size is stopped as inflateOverrun", async () => {
    const c = new ProfilerController(deps());
    expect(await routeCaptureFile(c, fileOf("bomb.mycap", deflateBomb(8 * 1024 * 1024)))).toBe(false);
    expect(textOf(c, "error")).toContain("inflateOverrun");
    expect(c.view.source).toBeNull();
    c.dispose();
  });

  it("a file bigger than any capture is refused without reading it", async () => {
    const read = vi.fn(async () => new ArrayBuffer(0));
    const c = new ProfilerController(deps());
    expect(await routeCaptureFile(c, { name: "huge.mycap", size: OPEN_MAX_FILE_BYTES + 1, arrayBuffer: read })).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(textOf(c, "error")).toContain(OPEN_REFUSALS.tooBig("huge.mycap", OPEN_MAX_FILE_BYTES + 1));
    // The bound is inclusive of a file exactly at it (the decoder's caps still apply to what it holds).
    expect(await routeCaptureFile(c, { name: "edge.mycap", size: OPEN_MAX_FILE_BYTES, arrayBuffer: read })).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    c.dispose();
  });
});

describe("drop and Open reach the same controller path", () => {
  it("extension check is case-insensitive and exact", async () => {
    expect(await isCaptureFileName("a.mycap")).toBe(true);
    expect(await isCaptureFileName("A.MYCAP")).toBe(true);
    expect(await isCaptureFileName("a.mycap.txt")).toBe(false);
    expect(await isCaptureFileName("mycap")).toBe(false);
  });

  it("installOpenCapture fills profilerSlots.onDropFile, the slot both the drop and Open call; its undo restores the slot", () => {
    const original = profilerSlots.onDropFile;
    const undo = installOpenCapture(profilerSlots);
    expect(profilerSlots.onDropFile).not.toBe(original);
    undo();
    expect(profilerSlots.onDropFile).toBe(original);
  });
});

describe("a capture saved on desktop or Android (Tauri Storage adds .bin)", () => {
  it("accepts name.mycap.bin, and still refuses other .bin files", async () => {
    expect(await isCaptureFileName("2026-11-13 sound-lab.mycap.bin")).toBe(true);
    expect(await isCaptureFileName("TAKE.MYCAP.BIN")).toBe(true);
    expect(await isCaptureFileName("level.bin")).toBe(false);
  });
});
