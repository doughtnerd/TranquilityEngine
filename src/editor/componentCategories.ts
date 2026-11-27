// How the Add Component menu groups types into submenus. Built-in (engine.*) components are
// categorised by this editor-side table (no engine API); scripts are grouped by their folder under
// scripts/; data components share one "Data" submenu.
import type { ComponentTypeInfo } from "../engine/editor";

const OTHER_CATEGORY = "Other";

/** Engine categories in menu order. Empty ones are left out of the menu. */
const ENGINE_CATEGORIES = ["Rendering", "Physics 2D", "Physics 3D", "Navigation", "Audio", "UI", "Animation", "Networking", "Input", OTHER_CATEGORY] as const;

/** The category of each built-in component, by its short name (`engine.` stripped). Navigation is by the `Nav` prefix. */
const BY_NAME: Readonly<Record<string, string>> = {
  Animator: "Animation",
  BoneAttachment: "Animation",
  Skeleton: "Animation",
  Skeleton2D: "Animation",
  SkinnedMeshRenderer: "Rendering",
  TimelineDirector: "Animation",
  Ragdoll: "Animation", // ADR 0375
  Camera: "Rendering",
  InputContext: "Input",
  MeshRenderer: "Rendering",
  SpriteRenderer: "Rendering",
  Light: "Rendering",
  Light2D: "Rendering",
  ShadowCaster2D: "Rendering",
  CompositeShadowCaster2D: "Rendering",
  Environment: "Rendering",
  Fog: "Rendering",
  Sky: "Rendering",
  PostProcessing: "Rendering",
  ReflectionProbe: "Rendering",
  ParticleSystem: "Rendering",
  WaterSurface: "Rendering",
  Tilemap: "Rendering",
  LineRenderer: "Rendering", // ADR 0396
  TrailRenderer: "Rendering",
  DecalProjector: "Rendering", // ADR 0395
  Decal2D: "Rendering",
  TilemapCollider2D: "Physics 2D",
  BoxCollider2D: "Physics 2D",
  CircleCollider2D: "Physics 2D",
  EdgeCollider2D: "Physics 2D",
  PolygonCollider2D: "Physics 2D",
  RigidBody2D: "Physics 2D",
  CharacterController2D: "Physics 2D",
  FixedJoint2D: "Physics 2D",
  HingeJoint2D: "Physics 2D",
  SliderJoint2D: "Physics 2D",
  RopeJoint2D: "Physics 2D",
  SpringJoint2D: "Physics 2D",
  BoxCollider: "Physics 3D",
  CapsuleCollider: "Physics 3D",
  MeshCollider: "Physics 3D",
  SphereCollider: "Physics 3D",
  RigidBody: "Physics 3D",
  Buoyancy: "Physics 3D",
  CharacterController: "Physics 3D",
  FixedJoint: "Physics 3D",
  HingeJoint: "Physics 3D",
  SliderJoint: "Physics 3D",
  BallJoint: "Physics 3D",
  RopeJoint: "Physics 3D",
  SpringJoint: "Physics 3D",
  AudioSource: "Audio",
  AudioListener: "Audio",
  AudioOccluder: "Audio", // ADR 0162
  AudioReverbZone: "Audio", // ADR 0162
  AudioZone: "Audio", // ADR 0347
  AudioSpeaker: "Audio", // ADR 0355
  AudioPackageLoader: "Audio", // ADR 0351
  SubtitleDisplay: "UI", // ADR 0357
  UIView: "UI",
  UIControlMapper: "UI",
};

/** The category of an engine component id, or null when the table doesn't know it (it lands in Other). */
function knownEngineCategory(id: string): string | null {
  const name = id.replace(/^[^.]*\./, "");
  if (name.startsWith("Nav")) return "Navigation";
  return BY_NAME[name] ?? null;
}

const engineCategory = (id: string): string => knownEngineCategory(id) ?? OTHER_CATEGORY;

/**
 * The folders under `scripts/` of the script that defines each id, found by looking for the id as
 * a string literal (`@behavior("game.Bird")`, `defineComponent("game.Scroller", …)`) in the
 * project's sources. Ids not found, or whose file is directly in scripts/, get no folders.
 */
function scriptFolders(ids: readonly string[], scripts: ReadonlyMap<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of ids) {
    for (const [path, source] of scripts) {
      if (!source.includes(`"${id}"`) && !source.includes(`'${id}'`) && !source.includes(`\`${id}\``)) continue;
      const parts = path.replace(/^scripts\//, "").split("/");
      out.set(id, parts.slice(0, -1));
      break;
    }
  }
  return out;
}


/** A submenu: its label, the path of labels from the top, nested submenus and its types. */
export interface MenuNode<T extends ComponentTypeInfo = ComponentTypeInfo> {
  readonly label: string;
  readonly path: readonly string[];
  readonly children: MenuNode<T>[];
  readonly items: T[];
}

const node = <T extends ComponentTypeInfo>(label: string, parent: readonly string[]): MenuNode<T> => ({ label, path: [...parent, label], children: [], items: [] });

/**
 * The menu tree: one submenu per non-empty engine category, then Scripts (nested by folder, scripts
 * directly in scripts/ beside the folders) and Data. Items keep the catalog's (name) order.
 */
export function buildMenuTree<T extends ComponentTypeInfo>(items: readonly T[], scripts: ReadonlyMap<string, string>): MenuNode<T>[] {
  const engine = new Map<string, MenuNode<T>>(ENGINE_CATEGORIES.map((c) => [c, node<T>(c, [])]));
  const scriptRoot = node<T>("Scripts", []);
  const data = node<T>("Data", []);
  const folders = scriptFolders(
    items.filter((i) => i.group === "Scripts").map((i) => i.id),
    scripts,
  );
  for (const item of items) {
    if (item.group === "Engine") engine.get(engineCategory(item.id))!.items.push(item);
    else if (item.group === "Data") data.items.push(item);
    else {
      let at = scriptRoot;
      for (const folder of folders.get(item.id) ?? []) {
        let next = at.children.find((c) => c.label === folder);
        if (!next) {
          next = node<T>(folder, at.path);
          at.children.push(next);
        }
        at = next;
      }
      at.items.push(item);
    }
  }
  const sortFolders = (n: MenuNode<T>) => {
    n.children.sort((a, b) => a.label.localeCompare(b.label));
    n.children.forEach(sortFolders);
  };
  sortFolders(scriptRoot);
  return [...engine.values(), scriptRoot, data].filter((n) => n.items.length > 0 || n.children.length > 0);
}
