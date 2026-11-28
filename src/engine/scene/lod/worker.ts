// The LOD generation worker (ADR 0459 §1): a module Worker the editor spawns (`workerGenerator.ts`,
// `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`) that runs `generateLods` on each mesh it
// is sent. meshoptimizer's wasm is embedded in its module, so nothing else is fetched.
import { serveLodGeneration, type LodPort } from "./workerGenerator";

serveLodGeneration(self as unknown as LodPort);
