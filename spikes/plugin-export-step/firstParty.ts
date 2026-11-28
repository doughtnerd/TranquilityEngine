// SPIKE: a first-party export step. Imported statically by the exporter (like catalogue.ts), so it must be Node- and
// browser-safe: this file imports only the contract. Toy content: myco.subtitles ships its default size as a slice.
import type { ExportStep } from "./exportStep";

export const subtitlesExportStep: ExportStep = {
  options: [
    { key: "defaultSize", label: "Default subtitle size", type: "number", default: 24 },
    { key: "captionLog", label: "Ship a caption log file", type: "boolean", default: false, debugOnly: true },
  ],
  run(ctx) {
    const shipsSpeakers = ctx.project.files.some((f) => f.endsWith(".lines.json"));
    return {
      manifest: { size: ctx.options.defaultSize as number, speakerNames: shipsSpeakers },
      ...(ctx.options.captionLog === true && { files: new Map([["captions.log", "# caption log (debug)\n"]]) }),
    };
  },
};

/** First-party steps by plugin name; catalogue order decides the run order. */
export const FIRST_PARTY_EXPORT_STEPS: Readonly<Record<string, ExportStep>> = { "myco.subtitles": subtitlesExportStep };
