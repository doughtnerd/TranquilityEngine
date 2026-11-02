import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { engineTypes, typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile(), engineTypes()],
  oxc: false,
  // Sample scripts (ADR 0031) import the engine as "tranquility", as project scripts do.
  resolve: { alias: { tranquility: fileURLToPath(new URL("./src/engine/index.ts", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
