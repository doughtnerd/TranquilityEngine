# Junior engineer review: ADRs 0451 and 0452

What I read: 0452 and 0451 (full); `docs/design/plugin-lanes-localisation/goal.md`; `spikes/studio-editor-halves/README.md`; `spikes/player-chunks/README.md` (section 1 only); `GLOSSARY.md`; `src/plugins/runtimeContext.ts` (1-200); `src/engine/localisation/Locale.ts` (t, has, setLanguage, configureLocale, loadLanguage); `src/engine/localisation/t.ts`; `runtime/strings.ts` (noStrings); `src/engine/debugLink/topics.ts`; `src/engine/debugLink/session.ts` (grep); `src/studio/boot/studioPlugins.ts`; `src/engine/index.ts:53-54`. Not read: the numbered related records, `plugins/audio/runtime/capture/`, `src/engine/audio/take/`, the Studio profiler, `playStats.ts`.

Verdict: approve with changes. Top concerns for someone new to this code:
1. The record never says how a diagnostics source reaches a connected tool (which topic, when sampled, when it enters the capture's META). Debugging a missing source is guesswork until it does.
2. Disabled plugins: `disableRuntimePlugin` passes stub contexts (`runtimeContext.ts:135-145`). `ctx.diagnostics` needs a no-op there, and the record doesn't say so.
3. "Localisation off" is less than it reads (see Using it).

## What was unclear

Terms I had to work out, with the definitions I'd want in the record:
- **Source:** one registration, named `<plugin>/<source>`. **Topic:** a debug link channel (`topics.ts`). The record never says whether a source is a topic or sits inside one. **Capture:** a saved file. **Take:** retired in prose but still live in code (`take.source`, `Audio.take`).
- **Record:** one framed entry, a 20-byte head plus payload. **Type number:** its kind byte. **META:** the JSON header. **Keyframe:** a full-state record that lets playback seek. **Look-back window:** recent history kept while connected; its length is undecided.
- **Debug link** (transport) and **deep link** (a profiler event that opens an asset) differ by one word and are easy to confuse. Rename one.
- **Runtime half, editor half, and the new `diagnostics` manifest key:** the first two are in GLOSSARY.md; the key is not.
- **Strings interface, provider, string table:** defined in 0451, but `strings` is also the asset kind being moved.
- **Plugin disabled:** `project.json` `plugins.disabled`. The record should link it.

## Using it

Diagnostics source (proposed; 0452 gives no signature for the views registry, so that part is a placeholder):

```ts
// plugins/physics/runtime/index.ts
activate(ctx) {
  ctx.diagnostics.source("myco.physics/bodies", () =>
    import("./diagnostics/bodies").then((m) => m.bodies)); // lazy, as take.source is
}
// plugins/physics/editor/diagnostics/index.ts  (manifest "diagnostics": "editor/diagnostics/index.ts")
// registers its tracks with the profiler's registry (signature not in the record)
```

Locale with the plugin disabled (`plugins.disabled: ["myco.localisation"]`):

```ts
import { Locale } from "myco";
Locale.t("menu.start");         // "menu.start", one console warning per key
Locale.has("menu.start");       // false
await Locale.setLanguage("fr"); // resolves; direction and fonts change, text stays keys
```

The `setLanguage` line works because the default `noStrings` loader resolves (`runtime/strings.ts:44-49`, `Locale.ts:63`, `loadLanguage` at `Locale.ts:230`). Two gaps:
- The record doesn't say that switching language silently changes no text.
- `myco` re-exports `t` and `tHtml` from the plugin (0451, Decision). If the plugin's module stays imported, its code stays in the bundle when disabled, and the byte saving isn't shown. Ask the author.

## Tasks I could take

Safe for me:
- Tests for `Locale.t` missing-key behaviour with no provider, through the public `Locale` API.
- The mechanical move of `src/editor/ui/localisation/` with import updates; `npm run check:filenames` after.
- A non-audio diagnostics source once the point exists (for example `core/frames`, wrapping Play Stats data).

Leave to someone senior:
- Moving capture framing, recorder and ownership out of `plugins/audio/runtime/capture/` (touches every reader and 0417).
- Routing string loads through the provider in boot (`configureLocale`, `Locale.ts:434`): order-sensitive.
- The disabled-plugin stub and `ctx.diagnostics`.
- Anything in navigation, which CLAUDE.md freezes, including the Play Stats counter adapter.
- Moving `t()`'s Svelte reactivity (`setLocaleTracker`, `t.ts:17`) onto the interface's `changed` signal.

## Debugging: "I registered a source and nothing shows"

Check in this order. Each step fails silently today.
1. **Is the plugin enabled in this build?** A disabled half runs against stubs (`runtimeContext.ts:129-145`), so a source registered there goes nowhere, with no warning.
2. **Is it a debug build?** Release builds collect nothing.
3. **Is a tool connected, or was the record key pressed?** Nothing is sampled otherwise (`session.ts` header: "Nothing is sent without a subscriber").
4. **Does `load` resolve?** It's an `import()`. Today a failing topic logs `the "<topic>" topic failed to sample` (`session.ts:158`); the record should say whether sources log the same way.
5. **Does `sample` write anything?** A sample is taken at the topic's rate (default 30 Hz), and an unreliable topic sends nothing when no records are written (`topics.ts`, `DebugSubscription.sample`).
6. **Did it register before capture start?** META's source table is written at start (0452, Decision). A late source's records are skipped by length and never show.
7. **Is there a views module?** No `diagnostics` key means data arrives with no tracks. The Studio activates only audio and physics (`studioPlugins.ts`), so a non-audio source has no views there.

Shortcut: press the record key, then inflate the file and read META. If your source is in the table, steps 1 to 6 passed and the gap is step 7. If not, the problem is before the file. Step 7 is the one a newcomer will hit first.

Also: the editor's Play Stats overlay uses `registerPlayStatsCounter` until it migrates. A counter that shows does not prove a diagnostics source works.

Questions for the author: which topic carries the sources (the record defers it); how the Studio finds views modules (a fixed list, or discovery, which matters for third-party plugins); and whether a disabled localisation plugin removes its bytes.
