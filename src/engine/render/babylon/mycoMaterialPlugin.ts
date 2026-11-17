/**
 * The base of the engine's Babylon material plugins whose code depends on their own fields (ADR 0225):
 * graph materials, water, probe blending, sprite UVs, height fog, soft particles and kernel particles.
 *
 * Babylon's `MaterialPluginBase` constructor registers a plugin with its material, and registering asks
 * the plugin for its code and defines (`getCustomCode`, `collectDefines`), before a subclass's
 * constructor has set the fields that code reads. So these plugins tell the base constructor not to
 * register, and register once their fields are set. This class owns that: a subclass calls `super`
 * with its name, priority and defines, sets its fields, then calls `register()` last. It also declares
 * the shader languages a plugin supports: Babylon's two, WGSL and GLSL, unless the subclass narrows it.
 *
 * Not public API (ADR 0010): Babylon never appears in the engine's public types.
 */
import type { Material } from "@babylonjs/core/Materials/material.js";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";

/** @internal A Babylon material plugin registered after its subclass's fields are set. */
export abstract class MycoMaterialPlugin extends MaterialPluginBase {
  /**
   * `defines` are the plugin's defines and their defaults (Babylon caches compiled programs by defines,
   * so a plugin whose code varies per instance gives each variant one of its own).
   */
  protected constructor(material: Material, name: string, priority: number, defines: { [name: string]: unknown }) {
    super(material, name, priority, defines, false);
  }

  /**
   * Adds the plugin to its material's plugin manager and switches it on. Call it once, last in the
   * subclass constructor: Babylon reads the plugin's code and defines here, so its fields must be set.
   */
  protected register(): void {
    this._pluginManager._addPlugin(this);
    this._enable(true);
  }

  /** The languages the plugin has code for: WGSL and GLSL. A plugin with code in fewer overrides this. */
  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.WGSL || shaderLanguage === ShaderLanguage.GLSL;
  }
}
