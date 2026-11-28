// Builds the full test set. `read(key)` returns Uint8Array: keys are 'models/<file>' (downloaded) or 'repo/<path>'.
import { makeRock, makeTree, makeBuilding } from './gen.mjs';
import { parseObj, parseGlb, gltfToMesh, loadGltfSeparate } from './loaders.mjs';

export const REAL = [
  { name: 'DamagedHelmet', glb: 'DamagedHelmet.glb' },
  { name: 'FlightHelmet', gltf: 'FlightHelmet' },
  { name: 'Lantern', glb: 'Lantern.glb' },
  { name: 'Avocado', glb: 'Avocado.glb' },
  { name: 'Sponza', gltf: 'Sponza' },
  { name: 'CesiumMan', glb: 'CesiumMan.glb', skinned: true },
  { name: 'Fox', glb: 'Fox.glb', skinned: true },
];

export async function loadAll(read, { only } = {}) {
  const out = [];
  const add = (name, kind, mesh, extra = {}) => { if (!only || only.includes(name)) out.push({ name, kind, mesh: { ...mesh, name }, ...extra }); };
  add('rock', 'procedural', makeRock());
  add('tree', 'procedural', makeTree());
  add('building', 'procedural', makeBuilding());
  for (const r of REAL) {
    if (only && !only.includes(r.name)) continue;
    let doc;
    if (r.glb) doc = parseGlb(await read('models/' + r.glb));
    else doc = loadGltfSeparate(await read(`models/${r.gltf}.gltf`), await read(`models/${r.gltf}.bin`));
    add(r.name, 'gltf', gltfToMesh(doc, r.name), { doc, skinned: !!r.skinned });
  }
  if (!only || only.includes('terrain')) add('terrain', 'obj', parseObj(await read('repo/samples/navigation/models/terrain.obj'), 'terrain'));
  if (!only || only.includes('ship')) add('ship', 'obj', parseObj(await read('repo/samples/pirates/models/ship.obj'), 'ship'));
  return out;
}
