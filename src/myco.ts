/**
 * The public `myco` module (ADR 0135): the core (`src/engine/index.ts`) plus every first-party runtime
 * half's public exports. Game code and project scripts import from here (`import { Sky } from "myco"`);
 * the engine library, the player's `myco.js` and the code editor's declarations are built from it.
 * three.js, Babylon.js and Rapier are never part of this surface (ADR 0010).
 */
export * from "./engine/index";

// A game built on the engine library has no host to activate plugins: Engine.create turns on every
// first-party runtime half unless the player, server or editor already chose a set (ADR 0135).
import { Engine as _Engine } from "./engine/core/Engine";
import { activateGamePlugins as _activate } from "./plugins/runtime";
import { runtimePluginsChosen as _chosen } from "./plugins/runtimeContext";
_Engine._defaultPlugins = () => {
  if (!_chosen()) _activate([]);
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

// The Tilemaps plugin (ADR 0103, 0135, 0136).
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

// The Sprites plugin (ADR 0140).
export { SpriteRenderer } from "./plugins/sprites/runtime";

// The Meshes and models plugin (ADR 0140).
export { MeshRenderer } from "./plugins/meshes/runtime";

// The Water plugin (ADR 0072, 0140).
export { Water, WaterSurface, type WaterSample } from "./plugins/water/runtime";

// The UI plugin (ADR 0069, 0076, 0140).
export {
  Text,
  type Anchor,
  UIButton,
  UICanvas,
  UIImage,
  UIInputField,
  UIPanel,
  UIText,
  type UIAlign,
  type UICanvasMode,
  type UIDisplay,
  type UIFlexDirection,
  type UIImageFit,
  type UIJustify,
  type UILength,
  type UIPositionType,
  type UITextAlign,
  type UIWordBreak,
  UIClassList,
  UIDocument,
  UIDocumentElement,
  UIEvents,
  type UIEvent,
  type UIEventHandler,
  type UIEventType,
  type UIListOptions,
  type UITag,
} from "./plugins/ui/runtime";

// The Environment plugin (ADR 0140).
export { Environment } from "./plugins/environment/runtime";

// The Post-processing plugin (ADR 0140).
export { PostProcessing, type ToneMapping } from "./plugins/post-processing/runtime";

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

// The Audio plugin (ADR 0157). Its settings types (`AudioSettings`…) stay in the core.
export { Audio, AudioSource, AudioListener, type AudioHandle, type AudioEventHandle, type EventOptions, type AudioStatus, type AudioReason, type AudioDebugInfo, type OneShotOptions, type Rolloff, type Bus } from "./plugins/audio/runtime";

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

// --- Third-party plugin SDK (ADR 0139) -----------------------------------------------------------
// What a third-party plugin's runtime half needs from `myco`: the plugin types, the SDK version its
// `plugin.json` `sdk` range is checked against, and the Physics plugin's backend contribution point
// (ADR 0137), so a backend plugin can be written against `myco` alone. Editor halves import
// `myco/editor` (the editor SDK). Kept apart from the first-party plugin export blocks above.
export type { PluginManifest } from "./plugins/manifest";
export type { RuntimePlugin, RuntimePluginContext, ContributionPoint } from "./plugins/runtimeContext";
export { SDK_VERSION, type ThirdPartyManifest, type PluginAssetKind } from "./plugins/thirdParty";
export { PHYSICS_BACKENDS, physicsBackends, registerPhysicsBackend } from "./plugins/physics/runtime";
export type {
  Vec2 as PhysicsVec2,
  Vec3 as PhysicsVec3,
  Quat as PhysicsQuat,
  Point2 as PhysicsPoint2,
  ShapeDesc2D,
  ShapeDesc3D,
  QueryShape2D,
  QueryShape3D,
  JointKind2D,
  JointKind3D,
  JointSettings,
  DimensionTypes,
  Dim2,
  Dim3,
  Pose,
  BodySettings,
  BackendBody,
  ColliderDesc,
  BackendCollider,
  JointDesc,
  BackendJoint,
  CharacterSettings,
  CharacterHit,
  BackendCharacter,
  RayHit,
  PhysicsCapabilities,
  PhysicsWorldBackend,
  PhysicsWorldOptions,
  PhysicsBackend,
  PhysicsBackend2D,
  PhysicsBackend3D,
  PhysicsWorld2DBackend,
  PhysicsWorld3DBackend,
  PhysicsDimension,
  PhysicsBackendRegistration,
} from "./plugins/physics/runtime";
