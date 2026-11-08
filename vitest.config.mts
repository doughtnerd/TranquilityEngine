import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { engineTypes, typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile(), engineTypes()],
  oxc: false,
  // Sample scripts (ADR 0031) import the engine as "myco", as project scripts do.
  resolve: { alias: { myco: fileURLToPath(new URL("./src/myco.ts", import.meta.url)), tranquility: fileURLToPath(new URL("./src/myco.ts", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `npm run bench` (vitest bench): ECS benchmarks, never part of `npm test`.
    benchmark: { include: ["bench/**/*.bench.ts"] },
  },
});
