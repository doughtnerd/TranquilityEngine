// A model file changed on disk reloads, and the meshes it replaces are disposed once the new ones have loaded,
// including a load that a second change replaced before it finished.
import { BufferGeometry } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../index";
import { loadMeshes, type ModelMesh } from "../scene/models";

const obj = (x: number) => `data:text/plain;base64,${Buffer.from(`o Tri\nv 0 0 0\nv ${x} 0 0\nv 0 1 0\nf 1 2 3\n`).toString("base64")}`;

/** Point the project at a new version of the model (the editor saving the file). */
function useVersion(x: number): void {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "models/tri.obj": obj(x) }));
}

afterEach(() => {
  vi.restoreAllMocks();
  Assets.clearSources();
});

describe("model reloads", () => {
  it("disposes a load that a quicker second reload replaced before it finished", async () => {
    const disposed = new Set<BufferGeometry>();
    const dispose = BufferGeometry.prototype.dispose;
    vi.spyOn(BufferGeometry.prototype, "dispose").mockImplementation(function (this: BufferGeometry) {
      disposed.add(this);
      dispose.call(this);
    });
    const isDisposed = (meshes: readonly ModelMesh[]) => meshes.length > 0 && meshes.every((m) => m.geometry && disposed.has(m.geometry));
    useVersion(1);
    const first = await loadMeshes("asset:models/tri.obj");
    useVersion(2);
    const middle = loadMeshes("asset:models/tri.obj");
    useVersion(3);
    const last = await loadMeshes("asset:models/tri.obj");
    const replaced = await middle;
    await new Promise((r) => setTimeout(r, 0));
    expect(isDisposed(first)).toBe(true);
    expect(isDisposed(replaced)).toBe(true);
    expect(last.some((m) => m.geometry && disposed.has(m.geometry))).toBe(false);
  });
});
