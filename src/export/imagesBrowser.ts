// The browser image codec for the editor's Export… (ADR 0119): decode with `createImageBitmap`,
// resize on an `OffscreenCanvas` and encode with `convertToBlob`. Chromium (and Tauri's
// WebView2) encode WebP, losslessly at quality 1; a browser that can't throws, and the exporter
// ships that image as it is.
import { clampTextureSize } from "../engine/scene/importSettings";
import type { ImageTranscoder } from "./images";

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

export const browserTranscoder: ImageTranscoder = async (bytes, request) => {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  try {
    const [width, height] = clampTextureSize(bitmap.width, bitmap.height, request.maxSize);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2D canvas");
    ctx.imageSmoothingEnabled = !request.nearest;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const type = request.webp ? "image/webp" : MIME[request.ext] ?? "image/png";
    const blob = await canvas.convertToBlob({ type, quality: request.webp ? (request.webp.lossless ? 1 : request.webp.quality / 100) : 0.92 });
    if (blob.type !== type) throw new Error(`this browser can't encode ${type}`);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height, sourceWidth: bitmap.width, sourceHeight: bitmap.height };
  } finally {
    bitmap.close();
  }
};
