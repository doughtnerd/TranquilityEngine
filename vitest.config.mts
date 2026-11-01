import { defineConfig } from "vitest/config";
import { engineTypes, typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile(), engineTypes()],
  oxc: false,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
