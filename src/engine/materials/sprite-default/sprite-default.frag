varying highp vec2 vTextureCoord;

uniform sampler2D uMainTex;
uniform lowp vec4 uMainColor;

void main() {
    gl_FragColor = texture2D(uMainTex, vTextureCoord);
    gl_FragColor.rgb *= uMainColor.rgb;
    gl_FragColor.a *= uMainColor.a;
}
