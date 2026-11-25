// The Secondary Textures tool's lit preview (ADR 0414): a sprite sheet shaded on the CPU by a test light, so a normal
// map can be checked without a scene. Not the renderer's maths (that's the GPU light pass, ADR 0399): an editor preview
// with one point light at `light` (pixels from the image's top-left, `height` above it) and a little ambient light.

/** RGBA pixels, row-major from the top-left (as `ImageData`). */
export interface PreviewPixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
}

/** `albedo` lit by a point light over its normal map `normal` (same size; tangent space, +Y up unless `greenDown`). */
export function litPreview(albedo: PreviewPixels, normal: PreviewPixels | null, light: { x: number; y: number; height: number }, greenDown = false, ambient = 0.2): Uint8ClampedArray<ArrayBuffer> {
  const { width, height } = albedo;
  const out = new Uint8ClampedArray(width * height * 4);
  const useNormal = !!normal && normal.width === width && normal.height === height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let nx = 0, ny = 0, nz = 1;
      if (useNormal) {
        nx = normal!.data[i]! / 127.5 - 1;
        ny = (normal!.data[i + 1]! / 127.5 - 1) * (greenDown ? -1 : 1);
        nz = normal!.data[i + 2]! / 127.5 - 1;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
      }
      // Image rows go down; the normal map's +Y (and the light's direction) go up the image.
      const lx = light.x - x, ly = y - light.y, lz = Math.max(light.height, 1);
      const ll = Math.hypot(lx, ly, lz) || 1;
      const k = ambient + Math.max(0, (nx * lx + ny * ly + nz * lz) / ll) * (1 - ambient);
      out[i] = albedo.data[i]! * k;
      out[i + 1] = albedo.data[i + 1]! * k;
      out[i + 2] = albedo.data[i + 2]! * k;
      out[i + 3] = albedo.data[i + 3]!;
    }
  }
  return out;
}
