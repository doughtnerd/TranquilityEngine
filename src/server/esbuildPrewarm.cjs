// Preloaded into esbuild-wasm's Node service process (ADR 0125, src/server/packages.ts). On some
// systems (seen with Node 26 on Windows) OpenSSL's random generator fails with "entropy source
// strength too weak" when its first use is a call from inside esbuild's WebAssembly; using it once
// up front, outside the WebAssembly, avoids that.
require("node:crypto").getRandomValues(new Uint8Array(32));
