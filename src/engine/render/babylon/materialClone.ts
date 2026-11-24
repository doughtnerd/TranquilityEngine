/**
 * Material copies that clean up after themselves: a clone freed with the texture copies Babylon made for
 * it, and copies (or multi-materials) freed once what they were made from goes.
 */
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { Observable } from "@babylonjs/core/Misc/observable.js";

/**
 * A clone of a material that frees what Babylon made for it. `Material.clone` copies each of the
 * material's textures (every one but render targets: `SerializationHelper.Clone`), and those copies are
 * the clone's alone, but `dispose()` without `forceDisposeTextures` leaves them in the scene. They are the
 * textures the clone added to the scene; `dispose` frees them with the clone, and leaves alone whatever
 * texture the clone was given since (its base's, a loaded image's, a probe's), which isn't its to free.
 * Null when the material can't be cloned.
 */
export function cloneMaterial<T extends Material>(base: T, name: string): { material: T; dispose(): void } | null {
  const scene = base.getScene();
  const before = scene.textures.length;
  const material = base.clone(name) as T | null;
  if (!material) return null;
  const made = scene.textures.slice(before);
  return {
    material,
    dispose: () => {
      material.dispose(false, false);
      for (const t of made) t.dispose();
    },
  };
}

/** Something that says when it's disposed (a material, a texture). */
interface Disposes<T> {
  readonly onDisposeObservable: Observable<T>;
}

/**
 * Run `gone` once, the first time one of `owners` is disposed (a copy or multi-material made from them is
 * stale then). The subscriptions end when `target` is disposed itself, so nothing outlives it.
 */
export function onOwnerDisposed<T, O>(target: Disposes<T>, owners: readonly Disposes<O>[], gone: () => void): void {
  let fired = false;
  const observers = [...new Set(owners)].map((o) =>
    o.onDisposeObservable.add(() => {
      if (fired) return;
      fired = true;
      gone();
    }),
  );
  target.onDisposeObservable.addOnce(() => {
    for (const observer of observers) observer.remove();
  });
}
