/**
 * Render texture assets on the Babylon backend (ADR 0109). Each `*.rendertexture.json` a World uses
 * becomes one Babylon `RenderTargetTexture`, made the first time a camera, material, sprite or UI image
 * names it, and kept for the renderer's life: everything that names the asset shares the one texture,
 * so a camera drawing into it shows up wherever it's sampled.
 *
 * The texture is only a target here: its own render loop is never used. The frame graph imports its
 * GPU texture and the camera's finish pass writes into it (`frameGraph.ts`, `CameraView.target`).
 *
 * A changed asset (the editor's inspector) resizes the texture in place; a changed format makes a new
 * one under the same path, which materials pick up when they're rebuilt (`version` changes).
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture.js";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../scene/Assets";
import { parseRenderTexture, type RenderTextureSettings } from "../renderTexture";

interface Entry {
  raw: unknown;
  settings: RenderTextureSettings;
  texture: RenderTargetTexture;
}

/** What a camera drawing into a render texture needs (frameGraph.ts). */
export interface RenderTarget {
  texture: InternalTexture;
  width: number;
  height: number;
  /** Linear half float, not tone mapped (`format: "hdr"`). */
  hdr: boolean;
  /** Whether the camera draws with a depth buffer. */
  depth: boolean;
  /** Changes when the target's layout changes (the frame graph rebuilds). */
  key: string;
}

/** @internal Render texture assets for one Babylon scene. */
export class BabylonRenderTextures {
  private readonly entries = new Map<string, Entry>();
  private readonly warned = new Set<string>();
  /** Bumped whenever an entry's texture object is replaced (format change). */
  version = 0;

  constructor(private readonly scene: Scene) {}

  /** The texture for a render texture asset path (`asset:` optional), or null when it isn't in the project. */
  texture(path: string): RenderTargetTexture | null {
    return this.entry(path)?.texture ?? null;
  }

  /** What a camera drawing into `path` writes to, or null. */
  target(path: string): RenderTarget | null {
    const e = this.entry(path);
    const internal = e?.texture.getInternalTexture();
    if (!e || !internal) return null;
    const { width, height, format, depth } = e.settings;
    return { texture: internal, width, height, hdr: format === "hdr", depth, key: `${e.texture.uniqueId}:${width}x${height}:${format}:${depth}` };
  }

  private entry(path: string): Entry | null {
    const key = path.replace(/^asset:/, "");
    if (!key) return null;
    let raw: unknown;
    try {
      raw = Assets.has(key) ? Assets.json(key) : undefined;
    } catch {
      raw = undefined;
    }
    const cached = this.entries.get(key);
    if (raw === undefined) {
      this.warnOnce(`missing|${key}`, `render texture "${key}" isn't in the project.`);
      return cached ?? null;
    }
    if (cached && cached.raw === raw) return cached;
    const { settings, problems } = parseRenderTexture(raw, key);
    for (const p of problems) this.warnOnce(`${key}|${p}`, p);
    if (cached && cached.settings.format === settings.format) {
      // Same format: change it in place, so everything sampling it keeps the same texture.
      if (cached.settings.width !== settings.width || cached.settings.height !== settings.height) cached.texture.resize({ width: settings.width, height: settings.height });
      applySampling(cached.texture, settings);
      cached.raw = raw;
      cached.settings = settings;
      return cached;
    }
    cached?.texture.dispose();
    const hdr = settings.format === "hdr";
    const texture = new RenderTargetTexture(`rendertexture:${key}`, { width: settings.width, height: settings.height }, this.scene, {
      generateMipMaps: false,
      type: hdr ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE,
      format: Constants.TEXTUREFORMAT_RGBA,
      generateDepthBuffer: false, // the frame graph gives the camera its own depth buffer
      // An LDR texture holds sRGB-encoded colour (the camera's finish pass encodes, as for the screen):
      // materials decode it like an image. An HDR one holds linear colour.
      gammaSpace: !hdr,
    });
    texture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    texture.renderList = []; // never rendered by Babylon's own loop
    applySampling(texture, settings);
    const entry = { raw, settings, texture };
    this.entries.set(key, entry);
    if (cached) this.version++;
    return entry;
  }

  /** Tests and the editor: the render textures made so far, by path. */
  state(): Record<string, { width: number; height: number; format: string }> {
    const out: Record<string, { width: number; height: number; format: string }> = {};
    for (const [k, e] of this.entries) out[k] = { width: e.settings.width, height: e.settings.height, format: e.settings.format };
    return out;
  }

  dispose(): void {
    for (const e of this.entries.values()) e.texture.dispose();
    this.entries.clear();
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}

function applySampling(texture: RenderTargetTexture, s: RenderTextureSettings): void {
  texture.updateSamplingMode(s.filter === "point" ? Texture.NEAREST_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE);
  const wrap = s.wrap === "repeat" ? Texture.WRAP_ADDRESSMODE : s.wrap === "mirror" ? Texture.MIRROR_ADDRESSMODE : Texture.CLAMP_ADDRESSMODE;
  texture.wrapU = wrap;
  texture.wrapV = wrap;
}
