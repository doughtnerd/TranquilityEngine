// The bus index remap of a reconfigure (ADR 0157, api §3): a voice on old bus index i moves to the bus of the same name
// in the new tree. The audio host applies it to the voice table when the bus tree changes.

/**
 * The remap rule (api §3): for each old bus index, the index of the same name in `to`, else 0 (the
 * root). Names are unique within a tree (the settings parse guarantees it).
 */
export function busRemap(from: readonly string[], to: readonly string[]): Uint8Array {
  const map = new Uint8Array(from.length);
  for (let i = 0; i < from.length; i++) {
    const j = to.indexOf(from[i]!);
    map[i] = j < 0 ? 0 : j;
  }
  return map;
}
