// The Node image codec for game builds (ADR 0119), on sharp (libvips).
import sharp from "sharp";
import { clampTextureSize } from "../engine/scene/importSettings";
import type { ImageTranscoder } from "./images";

export const sharpTranscoder: ImageTranscoder = async (bytes, request) => {
  const input = sharp(bytes, { animated: false });
  const meta = await input.metadata();
  if (!meta.width || !meta.height) throw new Error("not a readable image");
  const [width, height] = clampTextureSize(meta.width, meta.height, request.maxSize);
  let image = input;
  if (width !== meta.width || height !== meta.height) image = image.resize(width, height, { kernel: request.nearest ? "nearest" : "lanczos3" });
  if (request.webp) image = image.webp({ quality: request.webp.quality, lossless: request.webp.lossless, effort: 5 });
  else if (request.ext === "png") image = image.png({ compressionLevel: 9 });
  else if (request.ext === "webp") image = image.webp({ quality: 90 });
  else image = image.jpeg({ quality: 92 });
  const out = await image.toBuffer();
  return { bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), width, height, sourceWidth: meta.width, sourceHeight: meta.height };
};
