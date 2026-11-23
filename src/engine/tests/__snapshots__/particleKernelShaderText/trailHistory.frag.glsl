#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D ks0;
uniform highp sampler2D ks3;
uniform int yoff;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) - ivec2(0, yoff);
  o = vec4(texelFetch(ks0, c, 0).xyz, texelFetch(ks3, c, 0).w);
}
