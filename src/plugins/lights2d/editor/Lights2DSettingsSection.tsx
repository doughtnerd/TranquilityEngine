// The Project panel's 2D Lighting category (ADR 0399): the light blend styles, up to four: a name, the mask map channel
// that scales the style's light, and how much the light multiplies and adds to a lit sprite's colour. Edits go through
// the panel's undo history.
import { MAX_BLEND_STYLES, BLEND_STYLE_MASKS, type BlendStyleMask } from "../../../engine/render/lights2D/settings";
import { type ProjectSettingsSectionProps, NameList, ProblemList, NumberField, TextField } from "../../../editor/sdk";
import { addBlendStyle, addShadowLayer, blendStylesOf, moveBlendStyle, moveShadowLayer, removeBlendStyle, removeShadowLayer, renameBlendStyle, renameShadowLayer, setBlendStyle, shadowLayersOf } from "./lights2dSettingsModel";
import "./lights2d.css";

const MASK_LABELS: Record<BlendStyleMask, string> = { none: "No mask", r: "Mask R", g: "Mask G", b: "Mask B", a: "Mask A" };

export function Lights2DSettingsSection(props: ProjectSettingsSectionProps) {
  const { draft, set, fieldProblems } = props;
  return (
    <>
      <BlendStyles {...props} />
      <NameList
        title="Shadow layers"
        hint="a caster shadows a light when their shadow masks share one (empty mask: all)"
        names={shadowLayersOf(draft)}
        field="lighting2D.shadowLayers"
        problems={fieldProblems}
        item="shadow layer"
        onAdd={() => set("Add shadow layer", addShadowLayer(draft))}
        onRename={(i, v) => set(`Rename shadow layer to ${v}`, renameShadowLayer(draft, i, v))}
        onRemove={(i) => set("Remove shadow layer", removeShadowLayer(draft, i))}
        onMove={(i, by) => set("Reorder shadow layers", moveShadowLayer(draft, i, by))}
      />
    </>
  );
}

function BlendStyles({ draft, set, fieldProblems }: ProjectSettingsSectionProps) {
  const styles = blendStylesOf(draft);
  return (
    <div class="lights2d-styles" role="group" aria-label="Light blend styles">
      <p class="project-settings-hint">A lit sprite's colour is its colour × Σ(light × mask × multiply) + Σ(light × mask × add), over each blend style its lights use.</p>
      {styles.map((s, i) => (
        <div key={s.name} class="lights2d-style" data-blend-style={s.name}>
          <TextField label={`Blend style ${i + 1} name`} value={s.name} onCommit={(v) => set(`Rename blend style to ${v}`, renameBlendStyle(draft, i, v))} />
          <select aria-label={`${s.name} mask`} value={s.mask} onChange={(e) => set(`Set ${s.name} mask`, setBlendStyle(draft, i, { mask: (e.currentTarget as HTMLSelectElement).value as BlendStyleMask }))}>
            {BLEND_STYLE_MASKS.map((m) => (
              <option key={m} value={m}>
                {MASK_LABELS[m]}
              </option>
            ))}
          </select>
          <span class="lights2d-weight">×</span>
          <NumberField id={`l2d-mul-${i}`} label={`${s.name} multiply`} value={s.multiply} placeholder="1" onCommit={(v) => set(`Set ${s.name} multiply`, setBlendStyle(draft, i, { multiply: v ?? 1 }))} />
          <span class="lights2d-weight">+</span>
          <NumberField id={`l2d-add-${i}`} label={`${s.name} add`} value={s.add} placeholder="0" onCommit={(v) => set(`Set ${s.name} add`, setBlendStyle(draft, i, { add: v ?? 0 }))} />
          <span>
            <button class="icon" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => set("Reorder blend styles", moveBlendStyle(draft, i, -1))}>
              ↑
            </button>
            <button class="icon" aria-label={`Remove ${s.name}`} disabled={styles.length <= 1} onClick={() => set(`Remove blend style ${s.name}`, removeBlendStyle(draft, i))}>
              ×
            </button>
          </span>
        </div>
      ))}
      <button disabled={styles.length >= MAX_BLEND_STYLES} onClick={() => set("Add blend style", addBlendStyle(draft))}>
        Add Blend Style
      </button>
      {fieldProblems.length > 0 && <ProblemList label="2D Lighting problems" list={fieldProblems.filter((p) => p.field.startsWith("lighting2D")).map((p) => p.message)} />}
    </div>
  );
}
