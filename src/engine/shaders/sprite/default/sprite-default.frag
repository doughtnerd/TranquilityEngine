varying highp vec2 vTextureCoord;

uniform sampler2D uSampler;
uniform lowp vec4 uColor;

void main() {
    gl_FragColor = texture2D(uSampler, vTextureCoord);
    gl_FragColor.rgb *= uColor.rgb;
    gl_FragColor.a = uColor.a;
}
