import { describe, it } from "vitest";
// import { BUILTIN_MATERIALS, MAX_MATERIALS, builtinMaterials, parseOccluderMaterials, resolveDefaultMaterial } from "../audio/occlusionMaterials";

// L-A6b. ADR 0162 api-and-models §2.2. Skeleton: skipped until the leaf fills them.
describe("occluder materials (ADR 0162 §2.2)", () => {
  it.skip("the built-in table: none 0/22000/1, cloth -4/8000/0.3, glass -8/5000/0.4, wood -12/2500/0.5, metal -25/1200/0.6, concrete -30/800/0.6, in that order", () => {});
  it.skip("builtinMaterials returns a fresh copy each call", () => {});
  it.skip("absent (undefined) gives the six built-ins with no problem", () => {});
  it.skip("an authored name not built in is appended; one named like a built-in replaces it in place and keeps the built-in's other fields when omitted", () => {});
  it.skip("transmissionDb, cutoffHz, wetOcclusion clamp to their ranges with a problem each; attackMs and releaseMs clamp to 0..2000", () => {});
  it.skip("a non-number numeric field takes the built-in's (else concrete's) value plus a problem; a non-number attackMs is dropped plus a problem", () => {});
  it.skip("attackMs and releaseMs absent stay absent (the key is not on the object)", () => {});
  it.skip("a duplicate name is dropped plus a problem and the first wins; a non-object entry or an empty or missing name is dropped plus a problem", () => {});
  it.skip("a non-list gives the built-ins plus a problem; more than 32 authored entries ignore the rest plus a problem; the effective table never exceeds 32", () => {});
  it.skip("resolveDefaultMaterial: undefined gives concrete, a known name is kept, an unknown or non-string gives the first material plus the problem text", () => {});
});
