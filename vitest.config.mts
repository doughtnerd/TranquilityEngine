import { defineConfig } from "vitest/config";
import { typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile()],
  oxc: false,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
