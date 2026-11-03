/**
 * Myco Engine public API. Game code imports from here only; three.js, Rapier and Howler
 * are never part of this surface (ADR 0010).
 */
export { Engine, type EngineOptions } from "./core/Engine";
export type { WorldKind, TimeState } from "./core/World";
export type { Bootstrap, BootstrapConfig, BootstrapEngine, BootstrapSetting, LinkConfig, SystemSelection, WorldConfig, WorldHandle, WorldTag } from "./core/worlds";
export type { NetworkTime } from "./net/time";
export { Connection, ConnectionState, defineInput, defineRpc, type ConnectionNode, type ConnectionStateValue, type InputDef, type InputOptions, type InputStats, type RpcDef, type RpcRow, type RpcTarget } from "./net/messages";
export { Replicated } from "./net/Replicated";
export { replicate, type DataReplication, type ReplicatedSettings, type ReplicationMode } from "./net/replication";
export type { FieldEncoding } from "./net/codec";
export { isResimulating, predictedTick } from "./net/prediction";
export { Component, GameBehavior, Waits, type LifecycleHooks } from "./core/Component";
export { Time } from "./core/Time";
export { Color, Mathf, Quaternion, Vector2, Vector3, DEG2RAD, RAD2DEG, type Vec2Like, type Vec3Like, type Vec2Input, type Vec3Input } from "./core/math";
export { AssetRef, PlainObject, behavior, component, field, getComponentClass, getComponentId, getComponentOptions, getFields, registerComponent, type ComponentOptions, type FieldChoice, type FieldChoices, type FieldOptions, type FieldType, type ListFieldType } from "./core/registry";
export { defineBuffer, defineComponent, f32, i32, u8, type BufferDef, type DataComponentDef, type DataView } from "./core/data";
export { defineSystem, type Phase, type Row, type SystemContext, type SystemDef } from "./core/systems";
export type { ProjectSettings, ProjectSettingsInput } from "./core/settings";
export type { AntialiasMode, GraphicsSettings, QualityTier, ShaderLevel, ShadowQuality } from "./core/graphics";
export { Graphics } from "./render/Graphics";

export { GameObject, type InstantiateOptions } from "./scene/GameObject";
export { Transform } from "./scene/Transform";
export { SceneManager, type LoadSceneOptions } from "./scene/SceneManager";
export { SceneInstance, registerSceneMigration, type SceneFile } from "./scene/SceneLoader";
export { Assets, type AssetSource } from "./scene/Assets";
export type { ImportSettings, ModelNormals, ModelUpAxis, SpriteSlice, TextureFilter, TextureWrap } from "./scene/importSettings";
export type { MaterialSettings, MaterialShader } from "./scene/material";

export { Camera, Light, MeshRenderer, SpriteRenderer, Text, type Anchor, type LightType, type MaterialPropertyValue, type Projection } from "./render/components";

export { RigidBody2D, type BodyType, type ForceMode } from "./physics/RigidBody2D";
export { BoxCollider2D, CircleCollider2D, Collider2D, EdgeCollider2D, PolygonCollider2D, type ColliderPoint2D, type Collision2D, type PhysicsMaterial, type PhysicsMaterial2D } from "./physics/Collider2D";
export { Physics2D, type RaycastHit2D } from "./physics/Physics2D";
export { CollisionEvents2D, TriggerEvents2D, type PhysicsEvent2D } from "./physics/Physics2DWorld";

export { RigidBody, type RigidBodyConstraints } from "./physics/RigidBody";
export { BoxCollider, CapsuleCollider, Collider, MeshCollider, SphereCollider, type CapsuleDirection, type Collision } from "./physics/Collider";
export { Physics, type RaycastHit } from "./physics/Physics";
export { CollisionEvents, TriggerEvents, type PhysicsEvent } from "./physics/physics3d";

export { Audio, AudioSource } from "./audio/AudioSource";
export { Input } from "./input/Input";
export { Storage, MemoryStorage, type StorageBackend } from "./platform/Storage";
