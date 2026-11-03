// Internal to the render backend (ADR 0053): loads equirectangular environment maps and prefilters
// them for image-based lighting. three types are allowed here; none reach the public API.
import { EquirectangularReflectionMapping, PMREMGenerator, SRGBColorSpace, TextureLoader, type Texture, type WebGLRenderer } from "three";

/** How an environment image is decoded, by file extension; null for unsupported files. */
export function environmentKind(path: string): "hdr" | "exr" | "ldr" | null {
  const p = path.split(/[?#]/)[0]!.toLowerCase();
  if (p.endsWith(".hdr")) return "hdr";
  if (p.endsWith(".exr")) return "exr";
  if (/\.(png|jpe?g)$/.test(p)) return "ldr";
  return null;
}

/** Load an equirectangular image from `url`; `path` (the project path) picks the decoder. */
export async function loadEquirectangular(url: string, path: string): Promise<Texture> {
  const kind = environmentKind(path);
  let texture: Texture;
  if (kind === "hdr") {
    const { HDRLoader } = await import("three/examples/jsm/loaders/HDRLoader.js");
    texture = await new HDRLoader().loadAsync(url);
  } else if (kind === "exr") {
    const { EXRLoader } = await import("three/examples/jsm/loaders/EXRLoader.js");
    texture = await new EXRLoader().loadAsync(url);
  } else {
    texture = await new TextureLoader().loadAsync(url);
    texture.colorSpace = SRGBColorSpace;
  }
  texture.mapping = EquirectangularReflectionMapping;
  return texture;
}

/** Prefilter an equirectangular texture into a PMREM cube-UV texture for lighting. */
export function prefilter(renderer: WebGLRenderer, texture: Texture): Texture {
  const generator = new PMREMGenerator(renderer);
  try {
    return generator.fromEquirectangular(texture).texture;
  } finally {
    generator.dispose();
  }
}
