// Project Settings > Animation (T19): the project's clip compression profile, the first level clips inherit from
// (ADR 0371 "Compression": project profile → folder rule → model sidecar per clip → platform override). Folder rules and
// platform overrides are kept as `project.json` writes them. Edits go through the panel's undo history; a refused edit
// says why in the status bar.
import { BUILTIN_COMPRESSION, type CompressionKey } from "../../../../engine/animation/compile/settings";
import { applyToSettings, NumberField, ProblemList, Row, type ProjectSettingsSectionProps } from "../../../../editor/sdk";
import { animationSettings, setCompressionValue } from "./compressionSettingsModel";

const FIELDS: readonly { key: CompressionKey; label: string; suffix: string; placeholder: string }[] = [
  { key: "error", label: "Error bound", suffix: "mm", placeholder: String(BUILTIN_COMPRESSION.error) },
  { key: "maxRate", label: "Highest sample rate", suffix: "Hz", placeholder: "the clip's" },
  { key: "propertyError", label: "Property error bound", suffix: "units", placeholder: String(BUILTIN_COMPRESSION.propertyError) },
];

/** The Project panel's section view (`ProjectSettingsSectionContribution.view`). */
export function CompressionSettingsSection(props: ProjectSettingsSectionProps) {
  const { draft, set, fieldProblems } = props;
  const c = animationSettings.read(draft).compression;
  const at = (field: string) => fieldProblems.filter((p) => p.field === field || p.field.startsWith(`${field}.`));
  return (
    <>
      {props.problems.length > 0 && <ProblemList list={props.problems} label="Animation problems" />}
      {FIELDS.map((f) => (
        <Row key={f.key} label={f.label} problems={at(`animation.compression.${f.key}`)}>
          <NumberField id={`anim-compression-${f.key}`} label={f.label} value={c[f.key]} placeholder={f.placeholder} suffix={f.suffix} onCommit={(v) => applyToSettings(draft, set, setCompressionValue(draft, f.key, v), `Set ${f.label.toLowerCase()}`)} />
        </Row>
      ))}
      <Row label="Folder rules" problems={at("animation.compression.rules")}>
        <span>{c.rules.length === 0 ? "None" : `${c.rules.length} (first match wins; edited in project.json)`}</span>
      </Row>
    </>
  );
}
