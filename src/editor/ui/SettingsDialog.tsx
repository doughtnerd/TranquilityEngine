import { signal } from "@preact/signals";
import { settingsOpen } from "./dialogState";
import { useEffect, useRef, useState } from "preact/hooks";
import { PRODUCT_NAME } from "../brand";
import { askBeforeClearingReferences, askBeforeDeletingAssets, checkScriptsBeforePlay, historyLocation, historyPruneDays } from "../preferences";
import { cleanPruneDays } from "../historyPrune";
import { currentProject } from "../state";
import { removeProjectTheme, writeProjectTheme } from "../projectTheme";
import { cleanThemeName, parseThemeFile, serializeThemeFile, themeIdFor, toThemeFile } from "../themeFile";
import {
  activeOverrides,
  allPresets,
  customThemes,
  ignoreProjectTheme,
  projectTheme,
  PRESETS,
  projectThemeActive,
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

function GeneralSettings() {
  const location = historyLocation.value;
  return (
    <>
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
        <label class="settings-row">
          <span class="settings-label">Prune history older than</span>
          <input
            type="number"
            class="settings-size"
            min={0}
            max={36500}
            step={1}
            aria-label="Prune history older than (days, 0 = never)"
            value={cleanPruneDays(historyPruneDays.value)}
            onChange={(e) => (historyPruneDays.value = cleanPruneDays((e.currentTarget as HTMLInputElement).value))}
          />
          <span class="note">days (0 = never). The current branch is always kept.</span>
        </label>
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
        <label>
          <input
            type="checkbox"
            checked={checkScriptsBeforePlay.value}
            onChange={(e) => (checkScriptsBeforePlay.value = (e.currentTarget as HTMLInputElement).checked)}
          />
          Check scripts for type errors before Play
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
          <select value={preset.id} disabled={projectThemeActive.value} onChange={(e) => (themePreset.value = (e.currentTarget as HTMLSelectElement).value)}>
            {(projectThemeActive.value ? [preset] : allPresets.value).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <ThemeFiles />
        <div class="settings-colors">
          {BASE_KEYS.map((key) => {
            const value = overrides[key] ?? preset.base[key];
            const changed = key in overrides;
            return (
              <div key={key} class={`settings-color${changed ? " changed" : ""}`}>
                <label>
                  <input type="color" value={value} disabled={projectThemeActive.value} aria-label={`${BASE_LABELS[key]} colour`} onInput={(e) => setOverride(key, inputValue(e))} />
                  <span>{BASE_LABELS[key]}</span>
                </label>
                <code class="settings-hex">{value}</code>
                <button class="settings-reset-one" disabled={!changed || projectThemeActive.value} title={`Use ${preset.name}'s ${BASE_LABELS[key].toLowerCase()}`} aria-label={`Reset ${BASE_LABELS[key].toLowerCase()} colour`} onClick={() => setOverride(key, null)}>
                  ↺
                </button>
              </div>
            );
          })}
        </div>
        <div class="settings-row">
          <button disabled={!overridden || projectThemeActive.value} onClick={resetOverrides}>
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

/** Save text as a file download (the browser's save flow; in the desktop app, the webview's). */
function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Import and export a theme file, and the open project's own theme (ADR 0116). */
function ThemeFiles() {
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const preset = activePreset.value;
  const project = currentProject.value;
  const canKeepInProject = !!project && project.canSave && !!project.root && !!project.fileSystem;
  const fail = (what: string, err: unknown) => setMessage(`${what}: ${err instanceof Error ? err.message : String(err)}`);

  const onExport = () => {
    const file = toThemeFile(preset, activeOverrides.value);
    downloadText(`${themeIdFor(file.name).replace(/^custom-/, "")}.myco-theme.json`, serializeThemeFile(file));
    setMessage(`Exported "${file.name}".`);
  };
  const onImport = async (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    const file = el.files?.[0];
    el.value = "";
    if (!file) return;
    try {
      const { theme: imported, problems } = parseThemeFile(await file.text());
      if (!imported) return setMessage(`Couldn't import ${file.name}. ${problems.join(" ")}`);
      // Same name again replaces the earlier import; a built-in's name gets a suffix.
      const taken = new Set(PRESETS.map((p) => p.name.toLowerCase()));
      if (taken.has(imported.name.toLowerCase())) {
        imported.name = cleanThemeName(`${imported.name} (imported)`);
        imported.id = themeIdFor(imported.name);
      }
      customThemes.value = [...customThemes.value.filter((t) => t.id !== imported.id), imported];
      ignoreProjectTheme.value = true; // choosing a theme to use means you want to see it
      themePreset.value = imported.id;
      setMessage(`Imported "${imported.name}".${problems.length ? ` ${problems.join(" ")}` : ""}`);
    } catch (err) {
      fail("Couldn't read the file", err);
    }
  };
  const isCustom = customThemes.value.some((t) => t.id === preset.id);

  return (
    <>
      <div class="settings-row">
        <button onClick={onExport}>Export theme…</button>
        <button onClick={() => input.current?.click()}>Import theme…</button>
        <input ref={input} type="file" accept=".json,application/json" hidden aria-label="Theme file" onChange={onImport} />
        <button
          disabled={!isCustom || projectThemeActive.value}
          title="Remove this imported theme"
          onClick={() => {
            customThemes.value = customThemes.value.filter((t) => t.id !== preset.id);
            themePreset.value = "myco-dark";
          }}
        >
          Remove
        </button>
      </div>
      {project && (
        <div class="settings-row">
          <span class="settings-label">This project</span>
          {projectTheme.value ? (
            <>
              <label>
                <input type="checkbox" checked={!ignoreProjectTheme.value} onChange={(e) => (ignoreProjectTheme.value = !(e.currentTarget as HTMLInputElement).checked)} />
                Use the project's theme ("{projectTheme.value.name}")
              </label>
              <button disabled={!canKeepInProject} onClick={() => removeProjectTheme(project).then(() => setMessage("Removed the project's theme.")).catch((err) => fail("Couldn't remove the project theme", err))}>
                Remove project theme
              </button>
            </>
          ) : (
            <button
              disabled={!canKeepInProject}
              title={canKeepInProject ? "Save the current theme as .myco/theme.json so it applies to everyone who opens this project" : "This project can't be written to"}
              onClick={() =>
                writeProjectTheme(project, preset, activeOverrides.value)
                  .then(() => {
                    ignoreProjectTheme.value = false;
                    setMessage("Saved as this project's theme (.myco/theme.json).");
                  })
                  .catch((err) => fail("Couldn't save the project theme", err))
              }
            >
              Use current theme for this project
            </button>
          )}
        </div>
      )}
      {message && <p class="note" role="status">{message}</p>}
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

/** Re-exported from dialogState.ts (ADR 0083), where the menus read it without loading this dialog. */
export { settingsOpen };
