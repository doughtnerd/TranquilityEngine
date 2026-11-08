import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processImages, transcodeRequest, type ImageTranscoder } from "./images";
import { sharpTranscoder } from "./imagesNode";
import { MANIFEST_FORMAT } from "./format";
import type { WebBuildPlan } from "./webBuild";

const plan = (copies: string[]): WebBuildPlan => ({ manifest: { format: MANIFEST_FORMAT, name: "t", mainScene: null, files: copies, scripts: [] }, copies, generated: new Map() });
const sidecar = (o: object) => JSON.stringify({ format: "myco.import@1", ...o });

describe("transcodeRequest", () => {
  it("does nothing without maxSize or compression, and picks WebP quality and lossless for point filtering", () => {
    expect(transcodeRequest("a.png", { maxSize: 0, compression: "none", filter: "linear" })).toBeNull();
    expect(transcodeRequest("a.PNG", { maxSize: 64, compression: "none", filter: "linear" })).toEqual({ maxSize: 64, webp: null, nearest: false, ext: "png" });
    expect(transcodeRequest("a.png", { maxSize: 0, compression: "high", filter: "linear" })?.webp).toEqual({ quality: 50, lossless: false });
    expect(transcodeRequest("a.png", { maxSize: 0, compression: "low", filter: "point" })).toMatchObject({ webp: { quality: 90, lossless: true }, nearest: true });
  });
});

describe("processImages", () => {
  const fake: ImageTranscoder = async (bytes, r) => {
    const w = 100, h = 50;
    const k = r.maxSize > 0 && Math.max(w, h) > r.maxSize ? r.maxSize / Math.max(w, h) : 1;
    return { bytes: new Uint8Array(Math.floor(bytes.length / 4)), width: Math.round(w * k), height: Math.round(h * k), sourceWidth: w, sourceHeight: h };
  };
  const files: Record<string, string> = {
    "a.png.meta.json": sidecar({ maxSize: 50, platforms: { desktop: { maxSize: 0 } }, sprites: [{ name: "s", rect: [0, 0, 10, 10], pivot: [0.5, 0.5] }] }),
    "b.png.meta.json": sidecar({ compression: "normal" }),
    "c.png.meta.json": sidecar({ filter: "point" }),
  };
  const options = (platform: "web" | "desktop", log: string[] = []) => ({ platform, readText: (p: string) => files[p], readBytes: async () => new Uint8Array(400), transcode: fake, log: (l: string) => log.push(l) });
  const copies = ["a.png", "a.png.meta.json", "b.png", "b.png.meta.json", "c.png", "c.png.meta.json", "d.png", "e.gif"];

  it("resizes and compresses what the platform's settings say, leaving the rest", async () => {
    const out = await processImages(plan(copies), options("web"));
    expect([...(out.binaries?.keys() ?? [])].sort()).toEqual(["project/a.png", "project/b.png"]);
    const side = JSON.parse(out.generated.get("project/a.png.meta.json")!);
    expect(side).toMatchObject({ maxSize: 50, sourceSize: [100, 50], sprites: [{ name: "s", rect: [0, 0, 10, 10] }] }); // authored values untouched
    expect(out.generated.has("project/b.png.meta.json")).toBe(false); // compressed, not resized: no sourceSize
  });

  it("uses the target platform's overrides", async () => {
    const out = await processImages(plan(copies), options("desktop"));
    expect([...(out.binaries?.keys() ?? [])]).toEqual(["project/b.png"]);
  });

  it("ships the original when processing fails or gains nothing", async () => {
    const log: string[] = [];
    const failing = await processImages(plan(copies), { ...options("web", log), transcode: async () => { throw new Error("bad"); } });
    expect(failing.binaries).toBeUndefined();
    expect(log.join("\n")).toMatch(/a\.png couldn't be processed \(bad\)/);
    const bigger = await processImages(plan(["b.png", "b.png.meta.json"]), { ...options("web"), transcode: async (b) => ({ bytes: new Uint8Array(b.length + 1), width: 100, height: 50, sourceWidth: 100, sourceHeight: 50 }) });
    expect(bigger.binaries).toBeUndefined();
  });
});

describe("sharpTranscoder", () => {
  it("downsizes and re-encodes real images", async () => {
    const png = await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toBuffer();
    const small = await sharpTranscoder(new Uint8Array(png), { maxSize: 16, webp: null, nearest: false, ext: "png" });
    expect([small.width, small.height, small.sourceWidth, small.sourceHeight]).toEqual([16, 8, 64, 32]);
    expect((await sharp(small.bytes).metadata()).format).toBe("png");
    const webp = await sharpTranscoder(new Uint8Array(png), { maxSize: 0, webp: { quality: 50, lossless: false }, nearest: false, ext: "png" });
    const meta = await sharp(webp.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 64, 32]);
  });
});
