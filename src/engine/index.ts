/**
 * TranquilityEngine public API. Game code imports from here only; three.js, Rapier and Howler
 * are never part of this surface (ADR 0010).
 */
export { Engine, type EngineOptions } from "./core/Engine";
export type { WorldKind } from "./core/World";
export { Component, GameBehavior, Waits, type LifecycleHooks } from "./core/Component";
export { Time } from "./core/Time";
export { Color, Mathf, Quaternion, Vector2, Vector3, DEG2RAD, RAD2DEG, type Vec2Like, type Vec3Like } from "./core/math";
export { AssetRef, PlainObject, behavior, component, field, getComponentClass, getComponentId, getFields, registerComponent } from "./core/registry";
export { defineBuffer, defineComponent, f32, i32, u8, type BufferDef, type DataComponentDef, type DataView } from "./core/data";
export { defineSystem, type Phase, type Row, type SystemContext, type SystemDef } from "./core/systems";
export type { ProjectSettings, ProjectSettingsInput } from "./core/settings";

export { GameObject, type InstantiateOptions } from "./scene/GameObject";
export { Transform } from "./scene/Transform";
export { SceneManager, type LoadSceneOptions } from "./scene/SceneManager";
export { SceneInstance, registerSceneMigration, type SceneFile } from "./scene/SceneLoader";
export { Assets, type AssetSource } from "./scene/Assets";

export { Camera, SpriteRenderer, Text, type Anchor, type Projection } from "./render/components";

export { RigidBody2D, type BodyType, type ForceMode } from "./physics/RigidBody2D";
export { BoxCollider2D, CircleCollider2D, Collider2D, type Collision2D } from "./physics/Collider2D";
export { Physics2D, type RaycastHit2D } from "./physics/Physics2D";
export { CollisionEvents2D, TriggerEvents2D, type PhysicsEvent2D } from "./physics/Physics2DWorld";

export { Audio, AudioSource } from "./audio/AudioSource";
export { Input } from "./input/Input";
export { Storage, MemoryStorage, type StorageBackend } from "./platform/Storage";
