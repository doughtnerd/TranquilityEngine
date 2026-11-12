// One peaks service, and so one decoder worker, per open project, shared by the segment view and the segment panel (Ed5,
// the build log's F-2). A file is read through its asset URL; a new URL is a new version, standing in for the mtime.
import { editor } from "../../../../editor/sdk";
import { createDecoderClient } from "../../runtime/decoder/decoderClient";
import { createPeaksService, type PeaksService } from "./peaks";

const peaksByProject = new WeakMap<object, PeaksService>();

export function peaksFor(project: NonNullable<typeof editor.project.current>): PeaksService {
  let service = peaksByProject.get(project);
  if (!service) {
    const versions = new Map<string, number>();
    const urlOf = (path: string): string => {
      const url = project.assets.get(path);
      if (typeof url !== "string") throw new Error(`${path} is not an audio file in the project`);
      return url;
    };
    service = createPeaksService({
      client: createDecoderClient(),
      source: {
        mtime: async (path) => {
          const url = urlOf(path);
          if (!versions.has(url)) versions.set(url, versions.size + 1);
          return versions.get(url)!;
        },
        read: async (path) => (await fetch(urlOf(path))).arrayBuffer(),
      },
    });
    peaksByProject.set(project, service);
  }
  return service;
}
