// Third-party export step, written in TypeScript. Type-only import: erased on compile.
import type { ExportStep } from "myco";
import { stampText } from "../shared/stamp";
import config from "./defaults.json";

const step: ExportStep = {
  options: [
    { key: "label", label: "Stamp label", type: "string", default: config.label },
    { key: "banner", label: "Write banner.txt", type: "boolean", default: true },
  ],
  async run(ctx) {
    const game = (ctx.project.settings.name as string | undefined) ?? "?";
    const scene = await ctx.project.read("scenes/main.scene.json"); // the host's file access, not node:fs
    return {
      manifest: { text: stampText(game, ctx.options.label as string), sceneBytes: String(scene).length },
      ...(ctx.options.banner === true && { files: new Map([["banner.txt", `${stampText(game, ctx.options.label as string)}\n`]]) }),
    };
  },
};
export default step;
