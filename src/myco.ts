/**
 * The public `myco` module (ADR 0135): the core (`src/engine/index.ts`) plus every first-party runtime
 * half's public exports. Game code and project scripts import from here (`import { Sky } from "myco"`);
 * the engine library, the player's `myco.js` and the code editor's declarations are built from it.
 * three.js, Babylon.js, Rapier and Howler are never part of this surface (ADR 0010).
 */
export * from "./engine/index";

// A game built on the engine library has no host to activate plugins: Engine.create turns on every
// first-party runtime half unless the player, server or editor already chose a set (ADR 0135).
import { Engine as _Engine } from "./engine/core/Engine";
import { RUNTIME_PLUGINS as _RUNTIME_PLUGINS } from "./plugins/runtime";
import { activateRuntimePlugins as _activate, runtimePluginsChosen as _chosen } from "./plugins/runtimeContext";
_Engine._defaultPlugins = () => {
  if (!_chosen()) _activate(_RUNTIME_PLUGINS);
};

// The Sky plugin (ADR 0112–0114, 0135).
export {
  Sky,
  SKY_FORMAT,
  MAX_CLOUD_LAYERS,
  defaultSky,
  defaultCloudLayer,
  parseSky,
  formatSky,
  SKY_PRESETS,
  skyPreset,
  type SkySettings,
  type SkyMode,
  type SunPlacement,
  type SkySun,
  type SkyAtmosphere,
  type SkyGradient,
  type SkySunDisc,
  type SkyMoon,
  type SkyCloudLayer,
  type SkyStars,
  type SkyHorizon,
  type SkyLighting,
  type SkyProblem,
  type SkyPresetId,
} from "./plugins/sky/runtime";

// The Tilemaps plugin (ADR 0103, 0135).
export {
  Tilemap,
  TilemapChanges,
  FLIP_DIAGONAL,
  FLIP_X,
  FLIP_Y,
  type TileChange,
  type TilemapLayerData,
  type TerrainDef,
  type TileCollision,
  type TileDef,
  type TilePattern,
  type TilePolygon,
  type TilesetData,
  type TileCollisionMode,
} from "./plugins/tilemaps/runtime";

// The Particles plugin (ADR 0057, 0060, 0135).
export { ParticleSystem, type ParticlePropertyValue } from "./plugins/particles/runtime";

// The Physics plugin (ADR 0005, 0045, 0105, 0135, 0137): 2D and 3D. Its backends (Rapier) come from other plugins.
export {
  RigidBody2D,
  BoxCollider2D,
  CircleCollider2D,
  Collider2D,
  EdgeCollider2D,
  PolygonCollider2D,
  Physics2D,
  CharacterController2D,
  AxisJoint2D,
  FixedJoint2D,
  HingeJoint2D,
  Joint2D,
  RopeJoint2D,
  SliderJoint2D,
  SpringJoint2D,
  TilemapCollider2D,
  CollisionEvents2D,
  TriggerEvents2D,
  type BodyType,
  type ForceMode,
  type ColliderPoint2D,
  type Collision2D,
  type PhysicsMaterial,
  type PhysicsMaterial2D,
  type RaycastHit2D,
  type ShapeCastHit2D,
  type ControllerColliderHit2D,
  type PhysicsEvent2D,
  RigidBody,
  BoxCollider,
  CapsuleCollider,
  Collider,
  MeshCollider,
  SphereCollider,
  Physics,
  CharacterController,
  AxisJoint,
  BallJoint,
  FixedJoint,
  HingeJoint,
  Joint,
  RopeJoint,
  SliderJoint,
  SpringJoint,
  CollisionEvents,
  TriggerEvents,
  Buoyancy,
  type RigidBodyConstraints,
  type CapsuleDirection,
  type Collision,
  type RaycastHit,
  type ShapeCastHit,
  type CollisionFlags,
  type ControllerColliderHit,
  type JointLimits,
  type JointMotor,
  type JointSpring,
  type PhysicsEvent,
  type BuoyancyMode,
} from "./plugins/physics/runtime";

// The Navigation plugin (ADR 0065, 0135). Its settings types (`NavigationSettings`…) are core exports.
export {
  NavAgent,
  NavAvoidanceObstacle,
  NavChunk,
  NavCostVolume,
  NavFlowGoal,
  NavGate,
  NavGroup,
  NavModifierVolume,
  NavObstacle,
  NavResolutionVolume,
  NavSurface,
  NavSurround,
  Navigation,
  type NavMode,
  type NavPathState,
  type NavWaypoint,
  type NavNearestPoint,
  type NavPathResult,
  type NavPathStatus,
  type NavRaycastHit,
  type NavDebugSettings,
} from "./plugins/navigation/runtime";

// The Materials plugin's public types (`Material`, `MaterialSettings`) are core exports: material
// resolution is a shared render service (ADR 0133).
