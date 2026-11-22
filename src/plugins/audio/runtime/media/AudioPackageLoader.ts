/**
 * Loads audio packages with its node (ADR 0337 §9; Wwise's `AkBank`). A scene's load waits for the packages its
 * `AudioPackageLoader`s name (the packages World service's `prepareScene`), so the scene doesn't start before its sound;
 * the loader then holds a reference on each, and drops them when it is destroyed (`unloadOnDestroy`, default true).
 * A loader added at runtime loads its packages as it activates (`Audio.package(name).state` says when they are in).
 */
import { Component } from "../../../../engine/core/Component";
import { component, field } from "../../../../engine/core/registry";
import { worldPlays } from "../AudioSource";
import { adoptPackages, releasePackages } from "./packages";

@component("engine.AudioPackageLoader")
export class AudioPackageLoader extends Component {
  @field([String], { description: "Packages from audio.json to load with this node; the scene waits for them." }) packages: string[] = [];
  @field(Boolean, { description: "Drop this loader's hold on its packages when the node is destroyed (the last hold unloads a package)." }) unloadOnDestroy = true;

  /** The names this loader took holds on (once, at its first activation). */
  private held: string[] | null = null;

  /** @internal */
  override _onActivate(): void {
    if (this.held) return;
    const world = this._world;
    // Only Worlds that play sound hold packages (not the editor's own World, a server or a headless World).
    if (!world || world.kind !== "runtime" || !worldPlays(world)) return;
    this.held = [...new Set(this.packages.filter((n) => typeof n === "string" && n !== ""))];
    adoptPackages(this, world, this.held);
  }

  /** @internal */
  override _onDetach(): void {
    if (this.held && this.unloadOnDestroy) releasePackages(this, this.held);
    this.held = null;
  }
}
