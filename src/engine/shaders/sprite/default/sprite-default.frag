varying highp vec2 vTextureCoord;

uniform sampler2D uDiffuse;
uniform lowp vec4 uDiffuseColor;

void main() {
    gl_FragColor = texture2D(uDiffuse, vTextureCoord);
    gl_FragColor.rgb *= uDiffuseColor.rgb;
    gl_FragColor.a *= uDiffuseColor.a;
}
