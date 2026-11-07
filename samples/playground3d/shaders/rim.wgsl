// Rim light: surfaces turned away from the camera glow in RimColor. The RIM keyword switches it.
fn surface(s: MycoSurfaceInput, out: ptr<function, MycoSurface>) {
  (*out).baseColor = uniforms.Tint.rgb;
#ifdef KW_RIM
  let facing = clamp(dot(normalize(s.normal), normalize(s.viewDir)), 0.0, 1.0);
  (*out).emission = uniforms.RimColor.rgb * pow(1.0 - facing, uniforms.RimPower);
#endif
}
