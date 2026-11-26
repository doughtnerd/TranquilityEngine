// ADR 0171/0172 (Pf8; api-and-models §7, §5): the words for every CaptureError code. A message test per code in `CAPTURE_ERROR_CODES`; the version codes are read from the real reader so
// both versions are asserted on what the reader writes. No assertion reads a wall clock.
import { describe, expect, it } from "vitest";
import { CAPTURE_ERROR_CODES, CaptureError, readCaptureHeader } from "../../runtime/capture/format";
import { sampleCapture } from "../../runtime/capture/testSupport";
import { captureErrorMessage } from "./openSaveFlow";

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

/** A code's headline: the message for it with no detail, less the code. */
const headline = (code: string): string => captureErrorMessage(code, "").replace(new RegExp(` ?\\(${code}\\)$`), "");
/** The route's own codes' headlines. */
const OPEN_ROUTE_HEADLINES = { notCapture: "Not a capture file.", open: "The file couldn't be opened." } as const;

const plain = (e: CaptureError): string => e.message.slice(`${e.code} at ${e.offset}: `.length);

describe("a message per CaptureError code", () => {
  for (const code of CAPTURE_ERROR_CODES) {
    it(`${code}: a headline, the code and the reader's detail`, () => {
      const head = headline(code);
      expect(head.length).toBeGreaterThan(10);
      expect(head.endsWith(".")).toBe(true);
      const msg = captureErrorMessage(code, "detail text at 42");
      expect(msg).toBe(`${head} (${code}) detail text at 42`);
    });
  }

  it("no two codes share a headline", () => {
    const heads = CAPTURE_ERROR_CODES.map(headline);
    expect(new Set(heads).size).toBe(heads.length);
  });

  it("the route's own codes and an unknown code still read well", () => {
    expect(captureErrorMessage("notCapture", "x.txt is not a capture file")).toBe(`${OPEN_ROUTE_HEADLINES.notCapture} (notCapture) x.txt is not a capture file`);
    expect(captureErrorMessage("open", "disk gone")).toBe(`${OPEN_ROUTE_HEADLINES.open} (open) disk gone`);
    expect(captureErrorMessage("fromTheFuture", "huh")).toBe("(fromTheFuture) huh");
    expect(captureErrorMessage("badMagic", "")).toBe("Not a Myco capture file. (badMagic)");
  });

  it("newerFormat and olderFormat name this build's format and the file's", () => {
    const bytes = new Uint8Array(sampleCapture());
    const header = readCaptureHeader(bytes);
    const mine = header.format;
    const minor = header.formatMinor;
    // ADR 0386: "incompatible version: file is x.y, this build reads a.b–c.d".
    const reads = `this build reads ${mine}.0\u2013${mine}.${minor}`;
    const newer = bytes.slice();
    newer[8] = mine + 1;
    const e1 = readerError(newer);
    expect(e1.code).toBe("newerFormat");
    const m1 = captureErrorMessage(e1.code, plain(e1));
    expect(m1).toContain(`incompatible version: file is capture format ${mine + 1}.${minor}`);
    expect(m1).toContain(reads);
    expect(m1).toContain("(newerFormat)");
    expect(m1).not.toMatch(/damaged/);
    const newerMinor = bytes.slice();
    new DataView(newerMinor.buffer).setUint16(84, minor + 1, true);
    const e3 = readerError(newerMinor);
    expect(e3.code).toBe("newerFormat");
    expect(captureErrorMessage(e3.code, plain(e3))).toContain(`file is capture format ${mine}.${minor + 1}, ${reads}`);
    const older = bytes.slice();
    older[8] = mine - 1;
    const e2 = readerError(older);
    expect(e2.code).toBe("olderFormat");
    const m2 = captureErrorMessage(e2.code, plain(e2));
    expect(m2).toContain(`file is capture format ${mine - 1}.${minor}`);
    expect(m2).toContain(reads);
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
