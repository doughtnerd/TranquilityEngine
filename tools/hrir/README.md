# HRIR converter (ADR 0157, task H2)

`convert.mjs` turns the IRCAM Listen IRC_Composite_C responses, as Chromium processed them
(commit `cbba46fd94646232cfd2318ac962138c2a98c1f9`), into `src/plugins/audio/runtime/wasm/myco_hrir.bin`, the
`format = 2` blob the audio core's HRTF panner reads (layout: `native/audio/crates/audio-dsp/src/hrtf/database.rs`).

Status: skeleton (H2-L1 fills it). Licence and acknowledgement: `docs/design/0157-audio-core/hrir-licence.md`.
