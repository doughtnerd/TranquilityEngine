/**
 * Scene format 4 → 5 (ADR 0375): a BallJoint's scalar `swingLimit: s` (a round cone) becomes `swing: { y: s, z: s }`,
 * the same cone in the elliptical form. Every `engine.BallJoint` field `swingLimit`, on a node, in a prefab
 * instance's override, an added component or an added node (the walk is `sceneFileWalk.ts`, ADR 0279), moves to
 * `swing`; a component that already has `swing` keeps it. A value that isn't a number is dropped to the default.
 *
 * Pure and synchronous, so it runs wherever scene files are read (editor, game, server, rewrite CLI).
 */
import type { SceneFile } from "./SceneLoader";
import { REMOVE_FIELD, mapSceneFile, renameField } from "./sceneFileWalk";

const BALL_JOINT = "engine.BallJoint";

/** The migration itself (registered by `SceneLoader` from version 4). */
export function migrateBallJointSwing(file: SceneFile): SceneFile {
  return mapSceneFile(file, {
    field: (component, field, value) => {
      if (component !== BALL_JOINT || field !== "swingLimit") return value;
      return typeof value === "number" && Number.isFinite(value) ? renameField("swing", { y: value, z: value }) : REMOVE_FIELD;
    },
  });
}
