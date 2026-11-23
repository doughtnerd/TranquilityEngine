// A project JSON asset's value for the animation runtime (graph sources, masks, skeleton profiles): JSON files load as
// their contents (`Assets.json`); a reference without a JSON ending (an imported or generated asset served by URL) is
// fetched and parsed. Rejects when neither works.
import { Assets, fetchAssetBytes } from "../../../../../engine/scene/Assets";

/** @internal The parsed value of the JSON asset at `path`. */
export async function readJsonAsset(path: string): Promise<unknown> {
  let url: string;
  try {
    return Assets.json(path);
  } catch {
    url = Assets.url(path); // throws for a missing asset: the caller reports it
  }
  return JSON.parse(new TextDecoder().decode(await fetchAssetBytes(url))) as unknown;
}
