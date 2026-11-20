// One peaks service per open project, shared by the segment view, the segment panel and the rules table (Ed5, the build
// log's F-2). The decode runs on the page's shared decoder worker of the build the project needs, the one the audio core
// uses too: the AAC build while `audio.codecs.aac` is on (the default build has no AAC reader, so an `.m4a` clip would
// draw no waveform), else the default one. The build is read at each request, so turning AAC on in Project Settings
// takes effect without reopening the project. A file is read through its asset URL; a new URL is a new version,
// standing in for the mtime.
import { editor } from "../../../../editor/sdk";
import { audioSection } from "../../../../engine/audio/audioSection";
import { sharedDecoderClient, type DecoderClient } from "../../runtime/decoder/decoderClient";
import { createPeaksService, type PeaksService } from "./peaks";

type Project = NonNullable<typeof editor.project.current>;

const peaksByProject = new WeakMap<object, PeaksService>();

/** The decoder client for `project`'s codecs as they are now. */
const decoderFor = (project: Project): DecoderClient =>
  sharedDecoderClient(audioSection((project.settings as { audio?: unknown }).audio).settings.codecs.aac ? "aac" : "default");

export function peaksFor(project: Project): PeaksService {
  let service = peaksByProject.get(project);
  if (!service) {
    const versions = new Map<string, number>();
    const urlOf = (path: string): string => {
      const url = project.assets.get(path);
      if (typeof url !== "string") throw new Error(`${path} is not an audio file in the project`);
      return url;
    };
    service = createPeaksService({
      client: { computePeaks: (...args) => decoderFor(project).computePeaks(...args) },
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
