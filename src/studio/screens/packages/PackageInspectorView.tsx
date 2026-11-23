// The Packages screen's package inspector (ADR 0351 §6, §7): the selected package's Preload, the platforms it ships on,
// its size and memory for the chosen platform against the budgets, the project's Strict rule, and the scripts naming
// packages that don't exist (the lint of `Audio.package("…")`). A view over props.
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Icon } from "../../components/Icon";
import { ENCODING_PLATFORMS } from "../../../engine/audio/encoding/defaults";
import type { PackageDef } from "../../../engine/audio/packaging/definitions";
import type { ImportPlatform } from "../../../engine/scene/importSettings";
import { figureText } from "../../encoding/estimate";
import { PLATFORM_LABELS } from "../samples/encodingModel";
import type { PackageNameLint } from "./packagesModel";
import type { ReportPackage } from "./reportModel";

export interface PackageInspectorViewProps {
  readonly def: PackageDef | null;
  readonly platform: ImportPlatform;
  /** The package's figures for the platform (null when it doesn't ship there). */
  readonly figures: ReportPackage | null;
  readonly exact: boolean;
  readonly strict: boolean;
  readonly lint: readonly PackageNameLint[];
  readonly readOnly?: boolean;
  onPreload(on: boolean): void;
  onShipsOn(platform: ImportPlatform, on: boolean): void;
  onStrict(on: boolean): void;
  onOpenScript(path: string): void;
}

export function PackageInspectorView(props: PackageInspectorViewProps) {
  const d = props.def;
  const ro = props.readOnly === true;
  return (
    <div class="pk-inspector">
      {!d ? (
        <EmptyState compact title="No package selected" icon={<Icon name="packages" size={28} />} body="A package's preload, platforms and totals." />
      ) : (
        <section aria-label={`${d.name} settings`}>
          <h3 class="smp-insp-title">{d.name}</h3>
          <label class="fld smp-check">
            <span>Preload</span>
            <input type="checkbox" checked={d.preload} disabled={ro} onChange={(e) => props.onPreload((e.currentTarget as HTMLInputElement).checked)} />
          </label>
          <p class="smp-muted">{d.preload ? "Loads when the game starts, before the first scene." : "Loads when a script or an AudioPackageLoader asks."}</p>
          <fieldset class="pk-platforms">
            <legend>Ships on</legend>
            {ENCODING_PLATFORMS.map((p) => (
              <label key={p}>
                <input type="checkbox" checked={d.platforms === null || d.platforms.includes(p)} disabled={ro} onChange={(e) => props.onShipsOn(p, (e.currentTarget as HTMLInputElement).checked)} /> {PLATFORM_LABELS[p]}
              </label>
            ))}
          </fieldset>
          <div class="fld">
            <span>{PLATFORM_LABELS[props.platform]}</span>
            <span>{props.figures ? `${figureText(props.figures.bytes, props.exact)} · memory ${figureText(props.figures.memoryBytes, props.exact)}` : "not shipped"}</span>
          </div>
        </section>
      )}
      <h4 class="smp-insp-section">Project</h4>
      <label class="fld smp-check">
        <span>Strict</span>
        <input type="checkbox" checked={props.strict} disabled={ro} onChange={(e) => props.onStrict((e.currentTarget as HTMLInputElement).checked)} />
      </label>
      <p class="smp-muted">{props.strict ? "A packaged sound plays only while one of its packages is loaded (refused with a warning otherwise), in builds, the editor's Play and the Studio." : "A packaged sound whose packages aren't loaded loads on demand, with a warning."}</p>
      {props.lint.length > 0 && (
        <>
          <h4 class="smp-insp-section">Scripts</h4>
          <ul class="pk-lint" aria-label="Unknown package names in scripts">
            {props.lint.map((l) => (
              <li key={`${l.path}:${l.line}`} class="pk-warning">
                <button class="smp-link" onClick={() => props.onOpenScript(l.path)}>{l.path}:{l.line}</button> names "{l.name}", which no package is called.
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
