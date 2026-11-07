/** Google's Draco decoder factory (Emscripten); see draco_decoder.js. */
declare const DracoDecoderModule: (config: { onModuleLoaded?: (module: unknown) => void }) => unknown;
export default DracoDecoderModule;
