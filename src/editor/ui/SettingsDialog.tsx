import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { rendererChoice, setStoredRendererChoice, storedRendererChoice, type RendererName } from "../../engine/editor";
import { PRODUCT_NAME } from "../brand";
import { askBeforeClearingReferences, askBeforeDeletingAssets, historyLocation } from "../preferences";
import {
  activeOverrides,
  activePreset,
  BASE_KEYS,
  BASE_LABELS,
  CODE_FONT_SIZES,
  CODE_FONTS,
  codeFontFamily,
  codeFontSize,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  fonts,
  PRESETS,
  resetOverrides,
  setOverride,
  theme,
  themePreset,
  UI_FONT_SIZES,
  UI_FONTS,
  uiFontFamily,
  uiFontSize,
  type FontChoice,
} from "../theme";
import { aboutOpen } from "./AboutDialog";
import "./history.css";
import "./brand.css";

/** Whether the Settings dialog is open. */
export const settingsOpen = signal(false);

type Section = "general" | "appearance";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
];
/** The section showing (kept while the editor runs, so reopening returns to it). */
const section = signal<Section>("general");

/**
 * Editor settings (per user), in sections: General (where edit history is kept, the delete
 * prompts) and Appearance (theme preset, colour overrides, UI and code fonts, applied live).
 */
export function SettingsDialog() {
  const close = useRef<HTMLButtonElement>(null);
  const open = settingsOpen.value;
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    // On the window, not the dialog: some browsers (WebKit) don't focus checkboxes when clicked,
    // so a key press after ticking one wouldn't reach the dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || aboutOpen.peek()) return;
      e.preventDefault();
      e.stopPropagation();
      settingsOpen.value = false;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  const current = section.value;
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = SECTIONS.findIndex((s) => s.id === current);
    const next = SECTIONS[(i + (e.key === "ArrowRight" ? 1 : SECTIONS.length - 1)) % SECTIONS.length];
    section.value = next.id;
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`#settings-tab-${next.id}`)?.focus();
  };
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && (settingsOpen.value = false)}>
      <div class="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <h2 id="settings-title">Settings</h2>
        <div class="settings-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTabKey}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              id={`settings-tab-${s.id}`}
              role="tab"
              class={`settings-tab${current === s.id ? " active" : ""}`}
              aria-selected={current === s.id}
              aria-controls={`settings-panel-${s.id}`}
              tabIndex={current === s.id ? 0 : -1}
              onClick={() => (section.value = s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div class="settings-body" role="tabpanel" id={`settings-panel-${current}`} aria-labelledby={`settings-tab-${current}`}>
          {current === "general" ? <GeneralSettings /> : <AppearanceSettings />}
        </div>
        <div class="dialog-buttons">
          <button class="settings-about" onClick={() => (aboutOpen.value = true)}>
            About {PRODUCT_NAME}…
          </button>
          <button ref={close} onClick={() => (settingsOpen.value = false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** The renderer stored for the next load (ADR 0078); the one running now is `rendererChoice()`. */
const storedRenderer = signal<RendererName>(storedRendererChoice());

function RendererSettings() {
  const stored = storedRenderer.value;
  const running = rendererChoice();
  const pick = (name: RendererName) => {
    setStoredRendererChoice(name);
    storedRenderer.value = name;
  };
  return (
    <fieldset>
      <legend>Renderer</legend>
      <label>
        <input type="radio" name="renderer" checked={stored === "babylon"} onChange={() => pick("babylon")} />
        Babylon.js (default)
      </label>
      <label>
        <input type="radio" name="renderer" checked={stored === "three"} onChange={() => pick("three")} />
        three.js
      </label>
      {stored !== running ? (
        <p class="note">
          Running on {running === "babylon" ? "Babylon.js" : "three.js"}. The change applies when the editor reloads.{" "}
          <button onClick={() => location.reload()}>Reload now</button>
        </p>
      ) : (
        <p class="note">Games you play from the editor use it too. A `?renderer=` in the address overrides it.</p>
      )}
    </fieldset>
  );
}

function GeneralSettings() {
  const location = historyLocation.value;
  return (
    <>
      <RendererSettings />
      <fieldset>
        <legend>Edit history location</legend>
        <label>
          <input type="radio" name="history-location" checked={location === "project"} onChange={() => (historyLocation.value = "project")} />
          Project folder (.myco/history)
        </label>
        <label>
          <input type="radio" name="history-location" checked={location === "user"} onChange={() => (historyLocation.value = "user")} />
          Per user (outside the project)
        </label>
        <p class="note">Read-only projects, such as the bundled demo, always keep history per user.</p>
      </fieldset>
      <fieldset>
        <legend>Deleting</legend>
        <label>
          <input
            type="checkbox"
            checked={askBeforeClearingReferences.value}
            onChange={(e) => (askBeforeClearingReferences.value = (e.currentTarget as HTMLInputElement).checked)}
          />
          Ask before deleting a node other nodes reference
        </label>
        <label>
          <input
            type="checkbox"
            checked={askBeforeDeletingAssets.value}
            onChange={(e) => (askBeforeDeletingAssets.value = (e.currentTarget as HTMLInputElement).checked)}
          />
          Ask before deleting an asset or script
        </label>
      </fieldset>
    </>
  );
}

const inputValue = (e: Event) => (e.currentTarget as HTMLInputElement).value;

function AppearanceSettings() {
  const preset = activePreset.value;
  const overrides = activeOverrides.value;
  const tokens = theme.value;
  const f = fonts.value;
  const overridden = Object.keys(overrides).length > 0;
  return (
    <>
      <fieldset>
        <legend>Theme</legend>
        <label class="settings-row">
          <span class="settings-label">Preset</span>
          <select value={preset.id} onChange={(e) => (themePreset.value = (e.currentTarget as HTMLSelectElement).value)}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div class="settings-colors">
          {BASE_KEYS.map((key) => {
            const value = overrides[key] ?? preset.base[key];
            const changed = key in overrides;
            return (
              <div key={key} class={`settings-color${changed ? " changed" : ""}`}>
                <label>
                  <input type="color" value={value} aria-label={`${BASE_LABELS[key]} colour`} onInput={(e) => setOverride(key, inputValue(e))} />
                  <span>{BASE_LABELS[key]}</span>
                </label>
                <code class="settings-hex">{value}</code>
                <button class="settings-reset-one" disabled={!changed} title={`Use ${preset.name}'s ${BASE_LABELS[key].toLowerCase()}`} aria-label={`Reset ${BASE_LABELS[key].toLowerCase()} colour`} onClick={() => setOverride(key, null)}>
                  ↺
                </button>
              </div>
            );
          })}
        </div>
        <div class="settings-row">
          <button disabled={!overridden} onClick={resetOverrides}>
            Reset colours
          </button>
          <span class="note">Other colours (hover, borders, selection, warnings) follow these.</span>
        </div>
        <div class="theme-preview" aria-hidden="true">
          <div class="theme-preview-bar">
            <span>Preview</span>
            <span class="theme-preview-chip">Accent</span>
            <span class="theme-preview-chip two">Secondary</span>
          </div>
          <div class="theme-preview-row">Node</div>
          <div class="theme-preview-row selected">Selected node</div>
          <div class="theme-preview-row muted">
            Muted text · <span class="warn">warning</span> · <span class="err">error</span>
          </div>
          <code class="theme-preview-code" style={{ fontFamily: f.code, fontSize: `${f.codeSize}px` }}>
            const <span style={{ color: tokens.accent }}>speed</span> = 4.5;
          </code>
        </div>
      </fieldset>
      <fieldset>
        <legend>Fonts</legend>
        <FontPicker label="UI font" choices={UI_FONTS} value={uiFontFamily.value} onChange={(v) => (uiFontFamily.value = v)} />
        <SizeInput label="UI font size" value={f.uiSize} range={UI_FONT_SIZES} fallback={DEFAULT_UI_FONT_SIZE} onChange={(v) => (uiFontSize.value = v)} />
        <FontPicker label="Code font" choices={CODE_FONTS} value={codeFontFamily.value} onChange={(v) => (codeFontFamily.value = v)} />
        <SizeInput label="Code font size" value={f.codeSize} range={CODE_FONT_SIZES} fallback={DEFAULT_CODE_FONT_SIZE} onChange={(v) => (codeFontSize.value = v)} />
        <div class="settings-row">
          <button
            disabled={f.uiSize === DEFAULT_UI_FONT_SIZE && f.codeSize === DEFAULT_CODE_FONT_SIZE && uiFontFamily.value === UI_FONTS[0].value && codeFontFamily.value === CODE_FONTS[0].value}
            onClick={() => {
              uiFontFamily.value = UI_FONTS[0].value;
              uiFontSize.value = DEFAULT_UI_FONT_SIZE;
              codeFontFamily.value = CODE_FONTS[0].value;
              codeFontSize.value = DEFAULT_CODE_FONT_SIZE;
            }}
          >
            Reset fonts
          </button>
        </div>
      </fieldset>
    </>
  );
}

const CUSTOM = "custom";

/** A font family: one of `choices`, or Custom with a text field for any CSS font-family list. */
function FontPicker({ label, choices, value, onChange }: { label: string; choices: readonly FontChoice[]; value: string; onChange: (v: string) => void }) {
  const known = choices.some((c) => c.value === value);
  const [custom, setCustom] = useState(!known);
  const showCustom = custom || !known;
  return (
    <div class="settings-row">
      <label class="settings-row-label">
        <span class="settings-label">{label}</span>
        <select
          value={showCustom ? CUSTOM : value}
          onChange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            setCustom(v === CUSTOM);
            if (v !== CUSTOM) onChange(v);
          }}
        >
          {choices.map((c) => (
            <option key={c.label} value={c.value}>
              {c.label}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </label>
      {showCustom && (
        <input
          type="text"
          class="settings-font-input"
          aria-label={`${label} family`}
          placeholder='e.g. "Inter", sans-serif'
          value={value}
          onChange={(e) => onChange(inputValue(e))}
        />
      )}
    </div>
  );
}

/** A font size in px, clamped to `range`. */
function SizeInput({ label, value, range, fallback, onChange }: { label: string; value: number; range: { min: number; max: number }; fallback: number; onChange: (v: number) => void }) {
  return (
    <label class="settings-row">
      <span class="settings-label">{label}</span>
      <input
        type="number"
        class="settings-size"
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        onChange={(e) => {
          const n = Number(inputValue(e));
          onChange(Number.isFinite(n) && inputValue(e) !== "" ? Math.min(range.max, Math.max(range.min, Math.round(n))) : fallback);
        }}
      />
      <span class="note">px</span>
    </label>
  );
}
