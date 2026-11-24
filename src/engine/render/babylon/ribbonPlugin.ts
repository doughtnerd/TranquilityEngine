/**
 * Camera-facing ribbons (ADR 0396): a material plugin that turns each vertex of a ribbon to the camera drawing it,
 * in the material's own vertex shader, so one buffer serves every view (split screen, the editor's scene view and
 * its game inset). A ribbon's vertex sits on the centre line and carries the line's direction there and a side
 * (`mycoRibbonT`: xyz, side), a half width and an along-offset in half widths (`mycoRibbonE`); just after Babylon
 * computes the world position, the plugin moves it by
 * `normalize(cross(tangent, toEye)) × halfWidth × side + tangent × halfWidth × along`, `toEye` being the direction
 * to the camera (the camera's backward axis for an orthographic one), and points the normal at the camera.
 *
 * It goes on the line's material: the built-in line material, or a copy of a material asset or shader graph (never
 * the asset). Not public API (ADR 0010).
 */
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { MycoMaterialPlugin } from "./mycoMaterialPlugin";

/** The per-vertex attributes a ribbon carries. */
export const RIBBON_TANGENT = "mycoRibbonT";
export const RIBBON_EXTENT = "mycoRibbonE";

/** Where the ribbon's code goes in Babylon's PBR vertex shader (WGSL or GLSL); nothing in the fragment shader. */
export function ribbonCode(shaderType: string, language: ShaderLanguage): { [point: string]: string } | null {
  if (shaderType !== "vertex") return null;
  if (language === ShaderLanguage.WGSL) {
    return {
      CUSTOM_VERTEX_DEFINITIONS: `attribute ${RIBBON_TANGENT}: vec4f;\nattribute ${RIBBON_EXTENT}: vec2f;`,
      // Babylon's own point just after the world position (and its varyings) are worked out, before the clip
      // position: a named point, so it composes with a shader graph's vertex offset (which takes `worldPosition`).
      CUSTOM_VERTEX_UPDATE_WORLDPOS: [
            `var mycoRibbonDir: vec3f = (finalWorld * vec4f(vertexInputs.${RIBBON_TANGENT}.xyz, 0.0)).xyz;`,
            "mycoRibbonDir = mycoRibbonDir / max(length(mycoRibbonDir), 1e-6);",
            "var mycoToEye: vec3f = normalize(scene.vEyePosition.xyz - worldPos.xyz);",
            // An orthographic camera looks along its forward axis everywhere: face its backward axis.
            "if (scene.projection[3][3] > 0.5) { mycoToEye = -normalize(vec3f(scene.view[0][2], scene.view[1][2], scene.view[2][2])); }",
            "var mycoAcross: vec3f = cross(mycoRibbonDir, mycoToEye);",
            "if (length(mycoAcross) < 1e-5) { mycoAcross = cross(mycoRibbonDir, vec3f(0.0, 1.0, 0.0)); }",
            "if (length(mycoAcross) < 1e-5) { mycoAcross = cross(mycoRibbonDir, vec3f(1.0, 0.0, 0.0)); }",
            "mycoAcross = normalize(mycoAcross);",
            `let mycoE: vec2f = vertexInputs.${RIBBON_EXTENT};`,
            `worldPos = vec4f(worldPos.xyz + mycoAcross * (mycoE.x * vertexInputs.${RIBBON_TANGENT}.w) + mycoRibbonDir * (mycoE.x * mycoE.y), 1.0);`,
            "vertexOutputs.vPositionW = worldPos.xyz;",
            "#ifdef NORMAL",
            "vertexOutputs.vNormalW = mycoToEye;",
            "#endif",
          ].join("\n"),
    };
  }
  return {
    CUSTOM_VERTEX_DEFINITIONS: `attribute vec4 ${RIBBON_TANGENT};\nattribute vec2 ${RIBBON_EXTENT};`,
    CUSTOM_VERTEX_UPDATE_WORLDPOS: [
          `vec3 mycoRibbonDir = (finalWorld * vec4(${RIBBON_TANGENT}.xyz, 0.0)).xyz;`,
          "mycoRibbonDir = mycoRibbonDir / max(length(mycoRibbonDir), 1e-6);",
          "vec3 mycoToEye = normalize(vEyePosition.xyz - worldPos.xyz);",
          "if (projection[3][3] > 0.5) { mycoToEye = -normalize(vec3(view[0][2], view[1][2], view[2][2])); }",
          "vec3 mycoAcross = cross(mycoRibbonDir, mycoToEye);",
          "if (length(mycoAcross) < 1e-5) { mycoAcross = cross(mycoRibbonDir, vec3(0.0, 1.0, 0.0)); }",
          "if (length(mycoAcross) < 1e-5) { mycoAcross = cross(mycoRibbonDir, vec3(1.0, 0.0, 0.0)); }",
          "mycoAcross = normalize(mycoAcross);",
          `worldPos = vec4(worldPos.xyz + mycoAcross * (${RIBBON_EXTENT}.x * ${RIBBON_TANGENT}.w) + mycoRibbonDir * (${RIBBON_EXTENT}.x * ${RIBBON_EXTENT}.y), 1.0);`,
          "vPositionW = worldPos.xyz;",
          "#ifdef NORMAL",
          "vNormalW = mycoToEye;",
          "#endif",
        ].join("\n"),
  };
}

/** @internal Turns a ribbon material's vertices to the camera (see the file comment). */
export class MycoRibbonPlugin extends MycoMaterialPlugin {
  constructor(material: Material) {
    super(material, "MycoRibbon", 205, { MYCO_RIBBON: true });
    this.register();
  }
  override getClassName(): string {
    return "MycoRibbonPlugin";
  }
  override prepareDefines(defines: MaterialDefines): void {
    defines.MYCO_RIBBON = true;
  }
  override getAttributes(attributes: string[]): void {
    attributes.push(RIBBON_TANGENT, RIBBON_EXTENT);
  }
  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    return ribbonCode(shaderType, shaderLanguage ?? ShaderLanguage.GLSL);
  }
}
