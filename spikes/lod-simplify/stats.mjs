// node stats.mjs : model inventory + check that S.getScale == bounding-box max extent
import { MeshoptSimplifier as S } from './node_modules/meshoptimizer/meshopt_simplifier.js';
import { loadAll } from './lib/models.mjs';
import { nodeRead } from './lib/node-read.mjs';
import { weld, checkMesh, triCount, vertCount, bboxOf } from './lib/mesh.mjs';
await S.ready;
const all = await loadAll(nodeRead);
for (const e of all) {
  const w = weld(e.mesh); checkMesh(e.mesh); checkMesh(w);
  const b = bboxOf(w.positions, w.indices);
  console.log(e.name.padEnd(14), 'tris', triCount(e.mesh), 'verts raw', vertCount(e.mesh), 'welded', vertCount(w), 'groups', e.mesh.groups.length, e.mesh.joints ? 'skinned' : '',
    'getScale', S.getScale(w.positions, 3).toPrecision(5), 'maxExtent', b.maxExt.toPrecision(5), 'diag', b.diag.toPrecision(5));
}
