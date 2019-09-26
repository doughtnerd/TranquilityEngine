varying highp vec4 vColor;
varying highp vec2 vTextureCoord;
varying highp vec3 vNormal;

uniform sampler2D uSampler;
uniform highp vec3 uLightingDirection;

struct LightInfo {
    lowp vec3 positions[4]; //World positions of lights
    lowp vec3 directions[4]; // Defines the types of lights
    bool lightIsDirectional[4]; // Defines the types of lights
};

uniform LightInfo uLightInfo;

void main() {
    highp vec3 normal = normalize(vNormal);
    highp float light = dot(normal, uLightingDirection);
    gl_FragColor = texture2D(uSampler, vTextureCoord);
    gl_FragColor.rgb *= vColor.rgb;
    gl_FragColor.rgb *= light;
}
