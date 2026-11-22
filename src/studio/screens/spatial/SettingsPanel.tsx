// The Scene settings panel (ADR 0333 "Settings the Spatial screen shows are the project's"; the prototype's scene settings,
// B.4): `audio.json`'s Listening (HRTF for the nearest N voices, the ambisonic bed distance), Doppler amount and the
// occlusion materials, each change one undo step of the mix document (the Mixer's, so the Mixer's history shows it too).
import type { AudioProject } from "../../../engine/audio/project/types";
import { MATERIAL_LIMITS } from "../../../engine/audio/occlusionMaterials";
import { FieldRow, NumberBox, Section } from "../../../editor/ui/PanelFields";
import { FIELDS } from "./inspectorFields";
import { addMaterial, dopplerPercent, editMaterial, isBuiltinMaterial, removeMaterial, setBedBeyond, setDefaultMaterial, setDopplerPercent, setHrtfVoices } from "./settingsEdits";
import type { EditResult } from "./sceneEdits";

export interface SettingsPanelProps {
  readonly mix: AudioProject;
  readonly readOnly: boolean;
  onEdit(label: string, edit: (p: AudioProject) => EditResult<AudioProject>, drag?: boolean): boolean;
  onEndDrag(): void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { mix, readOnly: ro, onEdit } = props;
  const s = mix.settings;
  const occ = s.occlusion;
  const layers = occ.layers === null ? "every layer (sensors excluded)" : occ.layers.length === 0 ? "none: occlusion is off" : occ.layers.join(", ");
  return (
    <div class="sp-settings">
      <p class="sp-note">The project's settings (audio.json): they apply to the game as well as these scenes.</p>
      <Section title="Listening">
        <FieldRow label={FIELDS.hrtf.label} unit="voices" title="The nearest voices get HRTF; the rest are panned">
          <NumberBox label="HRTF voices" value={s.voices.hrtf} min={FIELDS.hrtf.min} max={FIELDS.hrtf.max} step={1} digits={0} disabled={ro} onValue={(v) => onEdit("HRTF voice count", (p) => setHrtfVoices(p, v))} />
        </FieldRow>
        <FieldRow label={FIELDS.bedBeyond.label} unit="m" title="Sounds farther than this mix into their bus's ambisonic bed">
          <input type="checkbox" aria-label="Send far sounds to the bed" checked={s.bedBeyond !== null} disabled={ro} onChange={(e) => onEdit("Ambisonic bed distance", (p) => setBedBeyond(p, (e.currentTarget as HTMLInputElement).checked ? 45 : null))} />
          {s.bedBeyond !== null ? (
            <NumberBox label="Bed distance" value={s.bedBeyond} min={FIELDS.bedBeyond.min} max={FIELDS.bedBeyond.max} step={1} digits={0} disabled={ro} onValue={(v) => onEdit("Ambisonic bed distance", (p) => setBedBeyond(p, v))} />
          ) : (
            <span class="sp-faint">Off: beds by priority only</span>
          )}
        </FieldRow>
      </Section>
      <Section title="Doppler">
        <FieldRow label="Amount" unit="%">
          <input type="range" class="sp-range" aria-label="Doppler amount slider" min={0} max={200} step={5} value={dopplerPercent(mix)} disabled={ro}
            onInput={(e) => onEdit("Doppler amount", (p) => setDopplerPercent(p, Number((e.currentTarget as HTMLInputElement).value)), true)} onChange={props.onEndDrag} />
          <NumberBox label="Doppler amount" value={dopplerPercent(mix)} min={0} max={200} step={5} digits={0} disabled={ro} onValue={(v) => onEdit("Doppler amount", (p) => setDopplerPercent(p, v))} />
        </FieldRow>
        <p class="sp-note">100% is physically accurate. Most games sound better around 50%.</p>
      </Section>
      <Section
        title="Occlusion"
        actions={<button type="button" class="sp-small" disabled={ro} onClick={() => onEdit("Add material", (p) => { const r = addMaterial(p); return "refused" in r ? r : { next: r.next.project }; })}>+ Material</button>}
      >
        <p class="sp-note">Obstacles block sound with their material: losses of several on one ray add up. Rays hit colliders on: {layers}.</p>
        <table class="sp-materials">
          <thead>
            <tr><th scope="col">Default</th><th scope="col">Material</th><th scope="col">Loss dB</th><th scope="col">Low-pass Hz</th><th scope="col">Wet cut</th><th scope="col"><span class="sp-sr">Remove</span></th></tr>
          </thead>
          <tbody>
            {occ.materials.map((m) => (
              <tr key={m.name}>
                <td><input type="radio" name="sp-default-material" aria-label={`${m.name} is the default`} checked={occ.defaultMaterial === m.name} disabled={ro} onChange={() => onEdit("Default material", (p) => setDefaultMaterial(p, m.name))} /></td>
                <td>
                  {isBuiltinMaterial(m.name) ? <span title="Built in: change it, but it keeps its name">{m.name}</span> : (
                    <input class="sp-mat-name" aria-label="Material name" value={m.name} disabled={ro}
                      onChange={(e) => { const v = (e.currentTarget as HTMLInputElement).value; if (!onEdit("Rename material", (p) => editMaterial(p, m.name, { name: v }))) (e.currentTarget as HTMLInputElement).value = m.name; }} />
                  )}
                </td>
                <td><NumberBox label={`${m.name} loss`} value={m.transmissionDb} min={MATERIAL_LIMITS.transmissionDb[0]} max={MATERIAL_LIMITS.transmissionDb[1]} step={1} digits={0} disabled={ro} onValue={(v) => onEdit("Edit material", (p) => editMaterial(p, m.name, { transmissionDb: v }))} /></td>
                <td><NumberBox label={`${m.name} low-pass`} value={m.cutoffHz} min={MATERIAL_LIMITS.cutoffHz[0]} max={MATERIAL_LIMITS.cutoffHz[1]} step={100} digits={0} disabled={ro} onValue={(v) => onEdit("Edit material", (p) => editMaterial(p, m.name, { cutoffHz: v }))} /></td>
                <td><NumberBox label={`${m.name} wet cut`} value={m.wetOcclusion} min={0} max={1} step={0.05} digits={2} disabled={ro} onValue={(v) => onEdit("Edit material", (p) => editMaterial(p, m.name, { wetOcclusion: v }))} /></td>
                <td>
                  {!isBuiltinMaterial(m.name) && (
                    <button type="button" class="sp-icon" aria-label={`Remove ${m.name}`} disabled={ro || occ.defaultMaterial === m.name} title={occ.defaultMaterial === m.name ? "The default material stays" : "Remove it (obstacles naming it use the default)"} onClick={() => onEdit("Remove material", (p) => removeMaterial(p, m.name))}>×</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Reverb zones">
        <p class="sp-note">The highest priority zone holding a sound wins; a zone marked Level default is used where none does.</p>
      </Section>
    </div>
  );
}
