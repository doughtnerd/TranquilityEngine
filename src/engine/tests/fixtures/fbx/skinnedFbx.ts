// Skinned ASCII FBX fixtures for the T14 import tests (ADR 0371: "fixtures must cover Mixamo-style and Blender
// exports"), written here from numbers (CC0: made for this project, no third-party data). Both are a quad skinned to a
// two-bone chain (Hips → Spine), with one blend shape ("Smile") and an animation stack "Take 001" (1 s) moving the hips,
// turning the spine and driving the blend shape.
//
// - "blender": an "Armature" null node turned -90° about X and scaled 0.01 above the bones (Blender's Z-up, centimetre
//   armature as its FBX exporter writes it), bone translations in its space; plain bone names.
// - "mixamo": bones at the top level in metres with Mixamo's "mixamorig:" names, and a pre-rotation on the spine
//   (FBX `PreRotation` with `RotationActive`, as Mixamo rigs carry).

const KTIME = 46186158000; // FBX ticks per second

export type FbxStyle = "blender" | "mixamo";

type Mat = number[];
const mul = (a: Mat, b: Mat): Mat => {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const translate = (x: number, y: number, z: number): Mat => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scale = (s: number): Mat => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
const rotX = (deg: number): Mat => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
};
const rotZ = (deg: number): Mat => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
};
const fmt = (n: number) => (Math.abs(n) < 1e-12 ? "0" : String(+n.toPrecision(12)));
const arr = (name: string, values: readonly number[]) => `${name}: *${values.length} {\n\t\t\ta: ${values.map(fmt).join(",")}\n\t\t}`;

/** World y of the bones once the scene is built (both styles): Hips 1, Spine 1.5. */
export const FBX_BONE_Y = { Hips: 1, Spine: 1.5 };

/** The fixture's ASCII FBX text. */
export function skinnedFbx(style: FbxStyle): string {
  const blender = style === "blender";
  const name = (b: string) => (blender ? b : `mixamorig:${b}`);
  // Bone locals (FBX Lcl Translation) and the armature above them.
  const armature = blender ? mul(rotX(-90), scale(0.01)) : translate(0, 0, 0);
  const hipsLocal = blender ? [0, 0, 100] : [0, 1, 0];
  const spineLocal = blender ? [0, 0, 50] : [0, 0.5, 0];
  const spinePre = blender ? 0 : 90; // Mixamo: a pre-rotation of 90° about Z on the spine, undone by its child frame
  const hipsWorld = mul(armature, translate(hipsLocal[0], hipsLocal[1], hipsLocal[2]));
  const spineWorld = mul(mul(hipsWorld, translate(spineLocal[0], spineLocal[1], spineLocal[2])), rotZ(spinePre));
  // The quad, in model (world) space: x 1 … 2, y 1 … 2.
  const vertices = [1, 1, 0, 2, 1, 0, 2, 2, 0, 1, 2, 0];
  const curveNode = (id: number, attr: string, props: string) => `\tAnimationCurveNode: ${id}, "AnimCurveNode::${attr}", "" {\n\t\tProperties70:  {\n${props}\t\t}\n\t}`;
  const curve = (id: number, times: number[], values: number[]) =>
    `\tAnimationCurve: ${id}, "AnimCurve::", "" {\n\t\tDefault: 0\n\t\tKeyVer: 4009\n\t\t${arr("KeyTime", times.map((t) => Math.round(t * KTIME)))}\n\t\t${arr("KeyValueFloat", values)}\n\t\t${arr("KeyAttrFlags", [24836])}\n\t\t${arr("KeyAttrDataFloat", [0, 0, 218434821, 0])}\n\t\t${arr("KeyAttrRefCount", [times.length])}\n\t}`;
  const p = (n: string, type: string, values: readonly number[]) => `\t\t\tP: "${n}", "${type}", "", "A",${values.map(fmt).join(",")}\n`;
  const hipsMoved = blender ? [100, 0, 100] : [1, 1, 0];
  return `; FBX 7.4.0 project file
; Myco Engine T14 fixture (${style}-style skinned quad), CC0.
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",${blender ? 1 : 100}
\t}
}
Objects:  {
\tGeometry: 10, "Geometry::Body", "Mesh" {
\t\t${arr("Vertices", vertices)}
\t\t${arr("PolygonVertexIndex", [0, 1, 2, -4])}
\t\tGeometryVersion: 124
\t}
\tModel: 20, "Model::Body", "Mesh" {
\t\tVersion: 232
\t}
${blender ? `\tModel: 25, "Model::Armature", "Null" {
\t\tVersion: 232
\t\tProperties70:  {
${p("Lcl Rotation", "Lcl Rotation", [-90, 0, 0])}${p("Lcl Scaling", "Lcl Scaling", [0.01, 0.01, 0.01])}\t\t}
\t}
` : ""}\tModel: 30, "Model::${name("Hips")}", "LimbNode" {
\t\tVersion: 232
\t\tProperties70:  {
${p("Lcl Translation", "Lcl Translation", hipsLocal)}\t\t}
\t}
\tNodeAttribute: 31, "NodeAttribute::${name("Hips")}", "LimbNode" {
\t\tTypeFlags: "Skeleton"
\t}
\tModel: 32, "Model::${name("Spine")}", "LimbNode" {
\t\tVersion: 232
\t\tProperties70:  {
${spinePre ? `\t\t\tP: "RotationActive", "bool", "", "",1\n${p("PreRotation", "Vector3D", [0, 0, spinePre])}` : ""}${p("Lcl Translation", "Lcl Translation", spineLocal)}\t\t}
\t}
\tNodeAttribute: 33, "NodeAttribute::${name("Spine")}", "LimbNode" {
\t\tTypeFlags: "Skeleton"
\t}
\tDeformer: 40, "Deformer::Skin", "Skin" {
\t\tVersion: 101
\t\tLink_DeformAcuracy: 50
\t}
\tDeformer: 41, "SubDeformer::${name("Hips")}", "Cluster" {
\t\tVersion: 100
\t\t${arr("Indexes", [0, 1, 3])}
\t\t${arr("Weights", [1, 1, 0.25])}
\t\t${arr("Transform", translate(0, 0, 0))}
\t\t${arr("TransformLink", hipsWorld)}
\t}
\tDeformer: 42, "SubDeformer::${name("Spine")}", "Cluster" {
\t\tVersion: 100
\t\t${arr("Indexes", [2, 3])}
\t\t${arr("Weights", [1, 0.75])}
\t\t${arr("Transform", translate(0, 0, 0))}
\t\t${arr("TransformLink", spineWorld)}
\t}
\tGeometry: 50, "Geometry::Smile", "Shape" {
\t\tVersion: 100
\t\t${arr("Indexes", [2])}
\t\t${arr("Vertices", [0, 0.5, 0])}
\t\t${arr("Normals", [0, 0, 0])}
\t}
\tDeformer: 51, "Deformer::Face", "BlendShape" {
\t\tVersion: 100
\t}
\tDeformer: 52, "SubDeformer::Smile", "BlendShapeChannel" {
\t\tVersion: 100
\t\tDeformPercent: 0
\t\t${arr("FullWeights", [100])}
\t}
\tAnimationStack: 60, "AnimStack::Take 001", "" {
\t\tProperties70:  {
\t\t\tP: "LocalStop", "KTime", "Time", "",${KTIME}
\t\t\tP: "ReferenceStop", "KTime", "Time", "",${KTIME}
\t\t}
\t}
\tAnimationLayer: 61, "AnimLayer::BaseLayer", "" {
\t}
${curveNode(62, "T", p("d|X", "Number", [hipsLocal[0]]) + p("d|Y", "Number", [hipsLocal[1]]) + p("d|Z", "Number", [hipsLocal[2]]))}
${curve(63, [0, 1], [hipsLocal[0], hipsMoved[0]])}
${curve(64, [0, 1], [hipsLocal[1], hipsMoved[1]])}
${curve(65, [0, 1], [hipsLocal[2], hipsMoved[2]])}
${curveNode(66, "R", p("d|X", "Number", [0]) + p("d|Y", "Number", [0]) + p("d|Z", "Number", [0]))}
${curve(67, [0, 1], [0, 0])}
${curve(68, [0, 1], [0, 0])}
${curve(69, [0, 1], [0, 90])}
${curveNode(70, "DeformPercent", p("d|DeformPercent", "Number", [0]))}
${curve(71, [0, 1], [0, 100])}
}
Connections:  {
\tC: "OO",20,0
\tC: "OO",10,20
${blender ? "\tC: \"OO\",25,0\n\tC: \"OO\",30,25" : "\tC: \"OO\",30,0"}
\tC: "OO",31,30
\tC: "OO",32,30
\tC: "OO",33,32
\tC: "OO",40,10
\tC: "OO",41,40
\tC: "OO",42,40
\tC: "OO",30,41
\tC: "OO",32,42
\tC: "OO",51,10
\tC: "OO",52,51
\tC: "OO",50,52
\tC: "OO",61,60
\tC: "OO",62,61
\tC: "OO",66,61
\tC: "OO",70,61
\tC: "OP",62,30, "Lcl Translation"
\tC: "OP",63,62, "d|X"
\tC: "OP",64,62, "d|Y"
\tC: "OP",65,62, "d|Z"
\tC: "OP",66,32, "Lcl Rotation"
\tC: "OP",67,66, "d|X"
\tC: "OP",68,66, "d|Y"
\tC: "OP",69,66, "d|Z"
\tC: "OP",70,52, "DeformPercent"
\tC: "OP",71,70, "d|DeformPercent"
}
`;
}
