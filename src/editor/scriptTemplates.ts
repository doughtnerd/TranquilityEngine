// New Script (ADR 0030): what a new script starts as, and which names are allowed. A script's
// file name, its class or constant, and the id it registers (`game.<Name>`) all come from one
// name, so components in scenes and the files that define them stay easy to match up.
import { scriptFor } from "./code/codeState";

/** What a new script defines: a script (GameBehavior), a data component, or a system (ADR 0007, 0017). */
export type ScriptKind = "behavior" | "data" | "system";

export const SCRIPT_KINDS: readonly { kind: ScriptKind; label: string; hint: string }[] = [
  { kind: "behavior", label: "Script", hint: "A component with its own lifecycle (update, start, …), attached to nodes." },
  { kind: "data", label: "Data component", hint: "Plain numbers on nodes, for systems to read and write." },
  { kind: "system", label: "System", hint: "Code that runs every frame over every node with the components it asks for." },
];

/** The id a script named `name` registers. */
export const scriptId = (name: string) => `game.${name}`;

/** The source a new script starts as. */
export function scriptTemplate(kind: ScriptKind, name: string): string {
  const id = scriptId(name);
  switch (kind) {
    case "behavior":
      return `import { GameBehavior, behavior, field } from "tranquility";

/** ${name}: what it does. Add it to nodes from the Inspector's Add Component list. */
@behavior("${id}")
export class ${name} extends GameBehavior {
  /** Fields marked @field show in the Inspector and are saved in the scene. */
  @field(Number) speed = 1;

  start(): void {
    // Runs once, before the first update.
  }

  update(): void {
    // Runs every frame. For example (import Time too): this.transform.rotation2D += this.speed * 90 * Time.deltaTime;
  }
}
`;
    case "data":
      return `import { defineComponent, f32 } from "tranquility";

/** ${name}: numbers stored on nodes. Systems query for it; add it to nodes from the Inspector. */
export const ${name} = defineComponent("${id}", { value: f32 });
`;
    case "system":
      return `import { Transform, defineSystem } from "tranquility";

/** ${name}: runs every frame over every node that has all the components in \`query\`. */
defineSystem({
  name: "${id}",
  phase: "update",
  query: [Transform],
  run(rows, ctx) {
    for (const row of rows) {
      // row.transform is each node's Transform; ctx.dt is the frame time in seconds.
    }
  },
});
`;
  }
}

/** A name from what someone typed: words joined in PascalCase ("enemy spawner" → "EnemySpawner"). */
export function scriptName(typed: string): string {
  return typed
    .trim()
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

/**
 * Why a script can't be called `name` in `folder` (a folder under `scripts/`), or null if it can:
 * it must be a valid identifier, its file must not exist, and no other script may register the
 * same id.
 */
export function whyNotScriptName(name: string, folder: string, scripts: ReadonlyMap<string, string>): string | null {
  if (!name) return "Type a name.";
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return "Use letters, digits and _ only, not starting with a digit.";
  const path = `${folder}/${name}.ts`;
  if (scripts.has(path)) return `${path} already exists.`;
  const other = scriptFor(scripts, scriptId(name));
  if (other) return `${other} already defines ${scriptId(name)}.`;
  return null;
}
