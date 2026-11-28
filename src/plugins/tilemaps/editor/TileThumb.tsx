// A tile drawn from its sprite slice (ADR 0103): a CSS background of the image, moved and scaled to show the slice's
// rect, with pixels left sharp. Shared by the Tileset inspector and the Tile Palette.
import { useEffect, useState } from "preact/hooks";
import type { TileDef } from "../runtime/tileset";
import { findSlice } from "../../../engine/scene/importSettings";
import { splitSprite } from "./tilesetAssets";
import { editor, type EditorProject, assetRefTarget } from "../../../editor/sdk";
import "./tileThumb.css";

const sizes = new Map<string, [number, number]>();

/** An image's natural size once it has loaded (null until then). */
function useImageSize(url: string | null): [number, number] | null {
  const [size, setSize] = useState<[number, number] | null>(url ? sizes.get(url) ?? null : null);
  useEffect(() => {
    if (!url) return setSize(null);
    const known = sizes.get(url);
    if (known) return setSize(known);
    let live = true;
    const img = new Image();
    img.onload = () => {
      const s: [number, number] = [img.naturalWidth, img.naturalHeight];
      sizes.set(url, s);
      if (live) setSize(s);
    };
    img.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  return size;
}

/** A tile's sprite source: its image's URL, and its slice's rect (pixels from the top-left), or null for the whole image. Null without an image. */
export function tileSpriteSource(project: EditorProject, tile: TileDef): { url: string; rect: [number, number, number, number] | null } | null {
  const ref = splitSprite(tile.sprite);
  const image = ref?.image ?? assetRefTarget(tile.sprite);
  const url = image ? project.assets.get(image) : null;
  if (typeof url !== "string") return null;
  const slice = ref ? findSlice(editor.assets.importSettings(project, image).settings, ref.slice) : undefined;
  return { url, rect: slice ? slice.rect : null };
}

/** The tile's sprite: its image URL and the rect (pixels from the top-left) to show; the whole image when it has no slice. */
function spriteView(project: EditorProject, tile: TileDef, size: [number, number] | null): { url: string; rect: [number, number, number, number] } | null {
  const source = tileSpriteSource(project, tile);
  if (!source) return null;
  if (source.rect) return { url: source.url, rect: source.rect };
  return size ? { url: source.url, rect: [0, 0, size[0], size[1]] } : null;
}

export function TileThumb(props: { project: EditorProject; tile: TileDef; size: number; class?: string }) {
  const { project, tile, size } = props;
  const natural = useImageSize(tileSpriteSource(project, tile)?.url ?? null);
  const view = natural ? spriteView(project, tile, natural) : null;
  const style: Record<string, string> = { width: `${size}px`, height: `${size}px` };
  if (view && natural) {
    const [x, y, w, h] = view.rect;
    const scale = Math.min(size / w, size / h);
    style.backgroundImage = `url("${view.url}")`;
    style.backgroundSize = `${natural[0] * scale}px ${natural[1] * scale}px`;
    style.backgroundPosition = `${-x * scale + (size - w * scale) / 2}px ${-y * scale + (size - h * scale) / 2}px`;
  }
  return <span class={`tile-thumb${view ? "" : " missing"}${props.class ? ` ${props.class}` : ""}`} style={style} title={tile.name ?? `Tile ${tile.id}`} aria-hidden="true" />;
}
