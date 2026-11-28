// The repo's vitest config, with `include` replaced (mergeConfig would concatenate it and run the whole suite).
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.mts";

export default defineConfig({ ...base, test: { ...base.test, include: ["spikes/studio-editor-halves/**/*.test.ts"] } });
