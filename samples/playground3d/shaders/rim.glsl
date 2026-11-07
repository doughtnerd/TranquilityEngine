// Rim light: surfaces turned away from the camera glow in RimColor. The RIM keyword switches it.
void surface(MycoSurfaceInput s, inout MycoSurface o) {
  o.baseColor = Tint.rgb;
#ifdef KW_RIM
  float facing = clamp(dot(normalize(s.normal), normalize(s.viewDir)), 0.0, 1.0);
  o.emission = RimColor.rgb * pow(1.0 - facing, RimPower);
#endif
}
