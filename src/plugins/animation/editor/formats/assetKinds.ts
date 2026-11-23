// The animation asset kinds in the editor (ADR 0371 "Assets", 0372, 0143, 0233, 0314): authored clips (`*.anim.json`),
// graphs (`*.animgraph.json`), timelines (`*.timeline.json`), avatar masks (`*.mask.json`), skeleton profiles
// (`*.skelprofile.json`) and pose database sources (`*.posedb.json`), each with its format (asset documents read and
// write it, ADR 0233), its New… entry and its `references` reader (ADR 0148); and the compiled files a project can hold
// (`*.skel.bin`, `*.anim.bin`, `*.animgraph.bin`, `*.posedb.bin`), listed with no format.
//
// Moves: the text kinds are JSON files, so a move rewrites the references in them through their owner, like every JSON
// file's reference strings (ADR 0302, 0314 "JSON files stay with their owners"); the readers below decide what a file
// depends on and is used by (so a bone or node path that happens to look like a file isn't a dependency). Parsers and
// reference lists are the engine's (`src/engine/animation/`). The animation tools add their panels and inspectors to
// these entries as they land.
//
// Field kinds (ADR 0143, D95): `animclip`, `animgraph`, `timeline`, `skelprofile` and `skeleton` are the `referencedAs`
// below; `sprite` is the core image kind's (an image's slices), which `Skeleton2D.sprite` takes as it is.
import type { AssetFormat, AssetKindContribution, AssetReferences } from "../../../../editor/sdk";
import { ANIM_SOURCE_SUFFIX, animSourceReferences, emptyAnimSource, formatAnimSource, parseAnimSource, type AnimSource } from "../../../../engine/animation/animSource";
import { ANIM_GRAPH_SUFFIX, animGraphReferences, emptyAnimGraph, formatAnimGraph, parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { TIMELINE_SUFFIX, emptyTimeline, formatTimeline, parseTimeline, timelineReferences, type Timeline } from "../../../../engine/animation/timeline";
import { MASK_SUFFIX, emptyMask, formatMask, maskReferences, parseMask, type AvatarMask } from "../../../../engine/animation/mask";
import { SKELETON_PROFILE_SUFFIX, emptySkeletonProfile, formatSkeletonProfile, parseSkeletonProfile, type SkeletonProfile } from "../../../../engine/animation/skeletonProfile";
import { POSE_DATABASE_SUFFIX, emptyPoseDatabase, formatPoseDatabase, parsePoseDatabase, poseDatabaseReferences, type PoseDatabaseSource } from "../../../../engine/animation/poseDatabase";
import type { FormatParse } from "../../../../engine/animation/shared";

/** A play triangle over a key line: a clip. */
const CLIP_ICON = "M4 18h16M7 15V9M12 15V6M17 15v-4M9 4l6 3.5L9 11z";
/** Three linked boxes: a graph of states. */
const GRAPH_ICON = "M3 4h6v5H3zM15 4h6v5h-6zM9 15h6v5H9zM9 6.5h6M6 9v8.5h3M18 9v8.5h-3";
/** Bars on a time ruler: a timeline. */
const TIMELINE_ICON = "M3 4v16M3 7h9M7 12h11M5 17h8M3 4h18";
/** A figure half filled: a mask. */
const MASK_ICON = "M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM7 21V12l5-2 5 2v9M12 10v11";
/** Joints on a chain: a skeleton profile. */
const PROFILE_ICON = "M12 3v6M12 9l-5 4M12 9l5 4M12 9v6M12 15l-3 6M12 15l3 6M7 13l-2 3M17 13l2 3";
/** A grid of poses: a pose database. */
const POSEDB_ICON = "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7zM6.5 5v3M17.5 5v3M6.5 16v3M17.5 16v3";
/** A bone: a compiled skeleton or other compiled animation data. */
const COMPILED_ICON = "M7 4a2 2 0 1 0-3 3l3 1 9 9 1 3a2 2 0 1 0 3-3l-3-1-9-9z";

const toProblems = (problems: readonly string[]) => problems.map((message) => ({ message }));

/** JSON text's parsed value, or undefined when it isn't JSON (a reader then names nothing). */
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** An engine format as an asset kind's format. */
function format<T>(parse: (raw: unknown, path?: string) => FormatParse<T>, write: (value: T) => string, empty: () => T): AssetFormat<T> {
  return {
    parse: (raw, path) => {
      const read = parse(raw, path);
      return { value: read.value, problems: toProblems(read.problems) };
    },
    format: write,
    empty,
  };
}

/** A reader of the files a format names (its own reference list on the parsed file). */
function reader<T>(suffix: string, parse: (raw: unknown) => FormatParse<T>, references: (value: T) => string[]): AssetReferences {
  return {
    extensions: [suffix],
    read: (_path, text) => {
      const raw = json(text);
      return raw === undefined ? [] : references(parse(raw).value);
    },
  };
}

/** @internal The authored clip format (`myco.anim-source@1`). */
export const animSourceFormat = format<AnimSource>(parseAnimSource, formatAnimSource, emptyAnimSource);
/** @internal The graph format (`myco.animgraph-source@1`). */
export const animGraphFormat = format<AnimGraph>(parseAnimGraph, formatAnimGraph, emptyAnimGraph);
/** @internal The timeline format (`myco.timeline@1`). */
export const timelineFormat = format<Timeline>(parseTimeline, formatTimeline, emptyTimeline);
/** @internal The avatar mask format (`myco.mask@1`). */
export const maskFormat = format<AvatarMask>(parseMask, formatMask, emptyMask);
/** @internal The skeleton profile format (`myco.skelprofile@1`). */
export const skeletonProfileFormat = format<SkeletonProfile>(parseSkeletonProfile, formatSkeletonProfile, emptySkeletonProfile);
/** @internal The pose database source format (`myco.posedb-source@1`). */
export const poseDatabaseFormat = format<PoseDatabaseSource>(parsePoseDatabase, formatPoseDatabase, emptyPoseDatabase);

/** The kinds, as registered (`register.ts`). */
export const ANIMATION_ASSET_KINDS: readonly AssetKindContribution[] = [
  {
    id: "animclip", extensions: [ANIM_SOURCE_SUFFIX], label: "Animation Clip", icon: CLIP_ICON, format: animSourceFormat, folder: "animation",
    create: { label: "New Animation Clip", what: "animation clips" },
    // `Animator.clip`, subclip keys (ADR 0372).
    referencedAs: ["animclip"],
    references: reader(ANIM_SOURCE_SUFFIX, parseAnimSource, animSourceReferences),
    // The clip preview (T18, `scene/ClipPreview.tsx`).
    inspector: () => import("../scene/ClipPreview").then((m) => m.ClipPreview),
  },
  {
    id: "animgraph", extensions: [ANIM_GRAPH_SUFFIX], label: "Animation Graph", icon: GRAPH_ICON, format: animGraphFormat, folder: "animation",
    create: { label: "New Animation Graph", what: "animation graphs" },
    // `Animator.graph` and linked-graph overrides.
    referencedAs: ["animgraph"],
    references: reader(ANIM_GRAPH_SUFFIX, parseAnimGraph, animGraphReferences),
  },
  {
    id: "timeline", extensions: [TIMELINE_SUFFIX], label: "Timeline", icon: TIMELINE_ICON, format: timelineFormat, folder: "animation",
    create: { label: "New Timeline", what: "timelines" },
    // `TimelineDirector.timeline`.
    referencedAs: ["timeline"],
    references: reader(TIMELINE_SUFFIX, parseTimeline, timelineReferences),
  },
  {
    id: "avatarmask", extensions: [MASK_SUFFIX], label: "Avatar Mask", icon: MASK_ICON, format: maskFormat, folder: "animation",
    create: { label: "New Avatar Mask", what: "avatar masks" },
    referencedAs: ["avatarmask"],
    references: reader(MASK_SUFFIX, parseMask, maskReferences),
  },
  {
    // A profile names no other file (sidecars, masks and skeletons name it).
    id: "skelprofile", extensions: [SKELETON_PROFILE_SUFFIX], label: "Skeleton Profile", icon: PROFILE_ICON, format: skeletonProfileFormat, folder: "animation",
    create: { label: "New Skeleton Profile", what: "skeleton profiles" },
    // `Skeleton.profile`.
    referencedAs: ["skelprofile"],
    references: { extensions: [SKELETON_PROFILE_SUFFIX], read: () => [] },
  },
  {
    id: "posedb", extensions: [POSE_DATABASE_SUFFIX], label: "Pose Database", icon: POSEDB_ICON, format: poseDatabaseFormat, folder: "animation",
    create: { label: "New Pose Database", what: "pose databases" },
    referencedAs: ["posedb"],
    references: reader(POSE_DATABASE_SUFFIX, parsePoseDatabase, poseDatabaseReferences),
  },
  // Compiled files (`myco.skel@1`, `myco.anim@1`, `myco.animgraph@1`, `myco.posedb@1`): binary, made by the editor's
  // compile and bake steps (or brought in), never edited. A compiled skeleton is what a `skeleton` field takes when no
  // model holds it; the others are listed so they don't show as unknown files.
  { id: "compiledskeleton", extensions: [".skel.bin"], label: "Skeleton (compiled)", icon: COMPILED_ICON, referencedAs: ["skeleton"] },
  { id: "compiledclip", extensions: [".anim.bin"], label: "Animation Clip (compiled)", icon: COMPILED_ICON, inspector: () => import("../scene/ClipPreview").then((m) => m.ClipPreview) },
  { id: "compiledgraph", extensions: [".animgraph.bin"], label: "Animation Graph (compiled)", icon: COMPILED_ICON },
  { id: "posedbbake", extensions: [".posedb.bin"], label: "Pose Database (baked)", icon: COMPILED_ICON },
];
