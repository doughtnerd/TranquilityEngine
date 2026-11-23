/**
 * Internal (ADR 0370): an item kernel (`itemKernel.ts`) on WebGL2, through float textures: one
 * full-screen pass per frame writes item i's outputs to texel (i % width, i / width) of RGBA32F render
 * targets (`outputs()`, one per output), which a draw samples by vertex index. Inputs are float
 * textures it owns, one texel per vec4 row. (Transform feedback is the alternative a spike may pick
 * for skinning; it would live here behind the same interface.) The caller restores its GL state after
 * `dispatch`, as with every pass of `webgl2.ts`.
 */
import { gridLayout, padToGrid, type GridLayout } from "./layout";
import { itemKernelGlsl, itemKernelGlslUniforms, type ItemKernelSpec } from "./itemKernel";
import { GlKernel, createItemTargets, deleteFloatTargets, floatTexture, readFloatTarget, writeFloatTexture, type FloatTargets } from "./webgl2";

export class GlItemKernel {
  /** Shader compile or link errors (empty when it built). */
  readonly errors: string[];
  private readonly pass: GlKernel;
  private targets: FloatTargets;
  private readonly inputs = new Map<string, { texture: WebGLTexture; grid: GridLayout }>();
  private n: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly spec: ItemKernelSpec,
    items: number,
  ) {
    this.pass = new GlKernel(gl, { label: `kernel ${spec.name}`, fragment: itemKernelGlsl(spec), uniforms: itemKernelGlslUniforms(spec) });
    this.errors = this.pass.errors;
    for (const name of spec.inputs) this.inputs.set(name, { texture: floatTexture(gl, 1, 1), grid: { width: 1, height: 1 } });
    this.n = items;
    this.targets = createItemTargets(gl, items, spec.outputs.length);
  }

  get items(): number {
    return this.n;
  }

  get lost(): boolean {
    return this.pass.lost;
  }

  /** The output grid (item i at texel (i % width, floor(i / width))). */
  get grid(): GridLayout {
    return { width: this.targets.width, height: this.targets.height };
  }

  /** The output textures, one per output, in the spec's order. */
  outputs(): readonly WebGLTexture[] {
    return this.targets.textures;
  }

  /** Replace input `name`'s table (vec4 rows); its texture is remade when the table's grid changes. */
  setInput(name: string, data: Float32Array): void {
    const input = this.inputs.get(name);
    if (!input) throw new Error(`item kernel "${this.spec.name}" has no input "${name}"`);
    const grid = gridLayout(Math.ceil(data.length / 4));
    if (grid.width !== input.grid.width || grid.height !== input.grid.height) {
      this.gl.deleteTexture(input.texture);
      input.texture = floatTexture(this.gl, grid.width, grid.height);
      input.grid = grid;
    }
    writeFloatTexture(this.gl, input.texture, 0, 0, grid.width, grid.height, padToGrid(data, grid));
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
  }

  /** Run every item into `outputs()`. */
  dispatch(): void {
    this.pass.run({ targets: this.targets }, (b) => {
      b.int("kitems", this.n);
      b.int("kgridw", this.targets.width);
      this.spec.inputs.forEach((name, unit) => {
        const input = this.inputs.get(name)!;
        b.texture(unit, `kin_${name}`, input.texture);
        b.int(`kin_${name}_w`, input.grid.width);
      });
    });
  }

  /** Run over `items` items from now on: the output textures are replaced (a draw rebinds them). */
  resize(items: number): void {
    if (items === this.n) return;
    deleteFloatTargets(this.gl, this.targets);
    this.n = items;
    this.targets = createItemTargets(this.gl, items, this.spec.outputs.length);
  }

  /** Read the outputs back, interleaved like the other runners (tools and tests; slow). */
  read(): Float32Array {
    const k = this.spec.outputs.length;
    const out = new Float32Array(this.n * k * 4);
    const px = new Float32Array(this.targets.width * this.targets.height * 4);
    for (let o = 0; o < k; o++) {
      readFloatTarget(this.gl, this.targets, o, px);
      for (let i = 0; i < this.n; i++) out.set(px.subarray(i * 4, i * 4 + 4), (i * k + o) * 4);
    }
    return out;
  }

  dispose(): void {
    this.pass.dispose();
    deleteFloatTargets(this.gl, this.targets);
    for (const i of this.inputs.values()) this.gl.deleteTexture(i.texture);
  }
}
