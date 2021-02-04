varying highp vec2 vTextureCoord;

uniform sampler2D uMainTex;
uniform lowp vec4 uMainColor;

void main() {
    gl_FragColor = texture2D(uMainTex, vTextureCoord);
    gl_FragColor.a *= uMainColor.a;
    gl_FragColor.rgb *= gl_FragColor.a;
}
