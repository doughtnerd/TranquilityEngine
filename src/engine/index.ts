/**
 * Myco Engine core API (ADR 0135): what the public `myco` module (`src/myco.ts`) re-exports, alongside
 * the first-party plugins' runtime halves. three.js, Rapier and Howler are never part of this surface
 * (ADR 0010).
 */
export { Engine, type EngineOptions } from "./core/Engine";
export type { WorldKind, TimeState } from "./core/World";
export type { Bootstrap, BootstrapConfig, BootstrapEngine, BootstrapSetting, LinkConfig, ReplicationSettings, SystemSelection, WorldConfig, WorldHandle, WorldTag } from "./core/worlds";
export type { NetworkTime } from "./net/time";
export { Connection, ConnectionState, defineInput, defineRpc, str, MAX_STR_BYTES, type ConnectionNode, type ConnectionStateValue, type InputDef, type InputOptions, type InputStats, type RpcDef, type RpcRow, type RpcSchema, type RpcTarget, type RpcValues, type StringType } from "./net/messages";
export { Lobby, type LobbyConnectOptions, type LobbyProfile } from "./net/lobby/client";
export { Match, type MatchInfo, type MatchPlayer } from "./net/lobby/match";
export type { LobbyMe, LobbyMember, LobbyOptions, LobbyRoom, LobbyRoomInfo, LobbyRoomState, LobbyState } from "./net/lobby/protocol";
export { Replicated } from "./net/Replicated";
export { Interest } from "./net/interest";
export { replicate, type DataReplication, type ReplicatedSettings, type ReplicationMode } from "./net/replication";
export type { FieldEncoding } from "./net/codec";
export { isResimulating, predictedTick } from "./net/prediction";
export { Component, GameBehavior, Waits, type LifecycleHooks, type PhysicsCollision, type PhysicsControllerHit } from "./core/Component";
export { Time } from "./core/Time";
export { Color, Mathf, Plane, Quaternion, Ray, Vector2, Vector3, DEG2RAD, RAD2DEG, type Vec2Like, type Vec3Like, type Vec2Input, type Vec3Input } from "./core/math";
export { ASSET_FIELD_KINDS, AssetRef, PlainObject, behavior, component, field, getComponentClass, getComponentId, getComponentOptions, getFields, registerComponent, type AssetFieldKind, type ComponentOptions, type FieldChoice, type FieldChoices, type FieldOptions, type FieldType, type ListFieldType } from "./core/registry";
export { defineBuffer, defineComponent, f32, i32, u8, type BufferDef, type ColumnArray, type Columns, type DataComponentDef, type DataView, type ScalarType, type Schema } from "./core/data";
export { defineSystem, type Phase, type Row, type SystemContext, type SystemDef } from "./core/systems";
export type { Rows } from "./core/rows";
export { defineWorldService, worldService, type WorldServiceKey } from "./core/worldServices";
export type { ProjectSettings, ProjectSettingsInput, ScaleMode } from "./core/settings";
export type { AntialiasMode, GraphicsSettings, ParticleQuality, QualityTier, ShaderLevel, ShadowQuality } from "./core/graphics";
export { Graphics } from "./render/Graphics";

export { GameObject, type InstantiateOptions } from "./scene/GameObject";
export { Transform } from "./scene/Transform";
export { SceneManager, type LoadSceneOptions } from "./scene/SceneManager";
export { SceneInstance, registerSceneMigration, type SceneFile } from "./scene/SceneLoader";
export { scene, prefab, ref, asset, setField, SceneBuilder, PrefabBuilder, NodeBuilder, type InstanceOptions, type NodeComponentOptions, type ComponentEntry, type NodeEntry, type OverrideEntry } from "./scene/sceneBuilder";
export { Assets, type AssetSource } from "./scene/Assets";
export type { ImportPlatform, ImportSettings, PlatformOverrides, TextureCompression, ModelNormals, ModelUpAxis, SpriteSlice, TextureFilter, TextureWrap } from "./scene/importSettings";
export type { MaterialSettings, MaterialShader } from "./scene/material";

// ParticleSystem (and ParticlePropertyValue) are the Particles plugin's public exports (`src/myco.ts`, ADR 0135);
// SpriteRenderer, MeshRenderer, Environment, PostProcessing, Text, WaterSurface and the UI Components
// are the Sprites, Meshes, Environment, Post-processing, UI and Water plugins' (ADR 0140).
export { Camera, Fog, Light, ReflectionProbe, type FogMode, type LightType, type MaterialPropertyValue, type ProbeRefresh, type Projection } from "./render/components";
export { Material, type MaterialValue } from "./render/Material";
export type { WaterWave } from "./render/water/gerstner";
export { CUBEMAP_FORMAT, parseCubemap, formatCubemap, type CubemapFaces, type CubeFace } from "./sky/cubemapFormat";

export type { NavAgentType, NavArea, NavigationSettings } from "./nav/settings";


export { Audio, AudioSource, type OneShotOptions, type Rolloff } from "./audio/AudioSource";
export type { Bus } from "./audio/mixer";
export { AudioListener } from "./audio/AudioListener";
export { Input } from "./input/Input";
export { Storage, MemoryStorage, type StorageBackend } from "./platform/Storage";
