//! Generator voices (ADR 0360 §3, ABI 5.1): a PLAY of a reserved clip id (`GEN_CLIP_ID_FIRST` + kind: 1 oscillator,
//! 2 synth, 3 blip, 4 silence) starts a voice that renders `audio_dsp::gen` instead of reading a clip. Nothing is
//! uploaded; the id is never in the clip store. Everything else about the voice is a clip voice's: ids and
//! generations, buses, mixed and virtual, pause, STOP, FADE, SET_PARAMS, ROUTE, SET_VOICE_FX, groups, REPLAY, sends,
//! submixes, spatial, beds, snapshots on its bus. The voice is mono (`panner.channels` 1).
//!
//! **State.** The `GenEntries` region holds a header, a [`SlotGen`] per voice slot (the kind, key-off and length
//! state, and the pool entry it holds) and the pool: **max(16, `max_mixed` / 4) entries** ([`entries_for`]), each a
//! whole [`GenVoice`] (parameters with their glides, oscillators, noise, filter, envelopes, LFO, the blip's state and
//! its phaser line), derived from the init parameters so `myco_audio_init` is unchanged. A generator PLAY takes an
//! entry for the voice's life, mixed or virtual. An entry is free when its owner slot no longer holds the live
//! generator voice whose id it keeps (so a voice ending, a slot taken over and RESET free it with no bookkeeping).
//! With none free the voice is **starved**: it plays silent, keeps time and ends at its key-off (by its `length`, or
//! its blip envelope's length, worked out from its GEN), counted in STATUS `genStarved`. **Silence** never takes an
//! entry: it is always virtual and ends at its `length` (the core forces it virtual at PLAY and refuses a promote).
//!
//! **GEN** (0x21, [`apply`]) sets the masked parameters (on arrival, like AUTOMATE): at once on a voice not started
//! or silent, else gliding smooth parameters over `rampFrames`; a non-zero seed re-seeds the noise. **AUTOMATE
//! target 5** (`automation.rs`) replaces a parameter with its curve's value each quantum, glided over the quantum
//! ([`automate`]).
//!
//! **Time and end** (in `voices::render_gen_voice`): the slot's `position` counts the voice's frames. A `length`
//! above 0 keys the voice off at that frame (sample-exactly); PLAY's loop flag makes it endless (a blip re-triggers
//! at its end) until SET_LOOP's release, its key-off ([`key_off`]). The voice ends when its amp envelope finishes
//! after the key-off, or for a blip at the end of its envelope; STOP fades it as any voice.

use audio_dsp::gen::{self, GenVoice};
use audio_wire::generated as wire;

use crate::core::{Core, Regions};
use crate::layout::REGION_ALIGN;
use crate::params::InitParams;
use crate::wire_read::u32_at;

/// The generator kind of clip id `clip` (1..=4), or `None` for any other id (a reserved id past the kinds too).
#[inline]
pub fn kind_of(clip: u32) -> Option<u8> {
    let k = clip.wrapping_sub(wire::GEN_CLIP_ID_FIRST);
    (1..=wire::GEN_KIND_SILENCE).contains(&k).then_some(k as u8)
}

/// [`SlotGen::flags`]: the voice was keyed off (by its length or a SET_LOOP release).
pub const KEYED_OFF: u8 = 1 << 0;
/// [`SlotGen::flags`]: the pool was full at its PLAY: it plays silent.
pub const STARVED: u8 = 1 << 1;

/// A voice slot's generator state, valid while the slot holds a generator voice (`kind_of(slot.clip)`). All-zero is
/// none.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SlotGen {
    /// The pool entry plus 1; 0 none (silence, or starved).
    pub entry: u16,
    pub kind: u8,
    /// [`KEYED_OFF`], [`STARVED`].
    pub flags: u8,
    /// The voice frame it keys off at (its `length`), 0 none. A voice with no entry ends there.
    pub keyoff_at: u32,
}

/// One pool entry: the slot that holds it (index + 1, 0 never used), that voice's id, and the voice.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Entry {
    pub owner: u32,
    pub id: u32,
    pub voice: GenVoice,
}

/// The region's scalars, first in it.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Header {
    pub entries: u32,
    pub max_logical: u32,
    pub sample_rate: f32,
    /// Generator PLAYs that found the pool full (cumulative; STATUS `genStarved` saturates it at u16).
    pub starved: u32,
}

/// The pool's size for `p`: max(16, `max_mixed` / 4) (64 on the high preset, 32 on the default).
pub fn entries_for(p: &InitParams) -> usize {
    (p.max_mixed as usize / 4).max(16)
}

const fn align(n: usize) -> usize {
    (n + REGION_ALIGN - 1) / REGION_ALIGN * REGION_ALIGN
}

/// Bytes of one entry, aligned.
pub const ENTRY_BYTES: usize = align(core::mem::size_of::<Entry>());

const fn sections(max_logical: usize, entries: usize) -> (usize, usize, usize) {
    let slots = align(core::mem::size_of::<Header>());
    let pool = align(slots + max_logical * core::mem::size_of::<SlotGen>());
    (slots, pool, pool + entries * ENTRY_BYTES)
}

/// The `GenEntries` region's size for `p` (`layout.rs`).
pub fn region_bytes(p: &InitParams) -> usize {
    sections(p.max_logical as usize, entries_for(p)).2
}

struct View<'a> {
    header: &'a mut Header,
    slots: &'a mut [SlotGen],
    entries: &'a mut [Entry],
}

fn view(region: &mut [u8]) -> Option<View<'_>> {
    if region.len() < core::mem::size_of::<Header>() {
        return None;
    }
    let base = region.as_mut_ptr();
    // SAFETY: the region is 64-byte aligned and zeroed at init (Layout); all-zero bytes are a valid Header, SlotGen
    // and Entry (integers, floats and arrays of them). `sections` places each table at an aligned offset inside
    // `region_bytes`, which `init` wrote into the header and which is checked against the region's length here. The
    // slices don't overlap. Only this module views these bytes.
    unsafe {
        let header = &mut *(base as *mut Header);
        let (ml, n) = (header.max_logical as usize, header.entries as usize);
        let (slots, pool, total) = sections(ml, n);
        if total > region.len() {
            return None;
        }
        Some(View {
            header,
            slots: core::slice::from_raw_parts_mut(base.add(slots) as *mut SlotGen, ml),
            entries: core::slice::from_raw_parts_mut(base.add(pool) as *mut Entry, n),
        })
    }
}

/// Fills the header (`Core::new`, and again after RESET zeroes the region).
pub fn init(core: &mut Core) {
    let p = *core.params();
    let region = &mut core.regions_mut().gen[..];
    if region.len() < region_bytes(&p) {
        return;
    }
    // SAFETY: as in `view`: the region starts with a Header and is large enough.
    let header = unsafe { &mut *(region.as_mut_ptr() as *mut Header) };
    *header = Header { entries: entries_for(&p) as u32, max_logical: p.max_logical, sample_rate: p.sample_rate, starved: 0 };
}

/// RESET: every slot record and entry goes (the starved count is cumulative and stays).
pub fn reset(core: &mut Core) {
    let starved = view(&mut core.regions_mut().gen[..]).map_or(0, |v| v.header.starved);
    core.regions_mut().gen.fill(0);
    init(core);
    if let Some(v) = view(&mut core.regions_mut().gen[..]) {
        v.header.starved = starved;
    }
}

/// Generator PLAYs that found the pool full since init (STATUS `genStarved`).
pub fn starved(regions: &mut Regions) -> u32 {
    view(&mut regions.gen[..]).map_or(0, |v| v.header.starved)
}

/// `true` while entry `e`'s owner slot holds the live generator voice whose id it keeps.
#[inline]
fn held(slots: &[crate::voices::VoiceSlot], e: &Entry) -> bool {
    e.owner != 0 && slots.get(e.owner as usize - 1).is_some_and(|s| s.id == e.id && crate::voices::is_live_state(s.state) && kind_of(s.clip).is_some())
}

/// The seconds a starved or silent voice of `kind` lasts by parameters `p` (a lookup of its parameter `i`), or `None`
/// when it lasts until its key-off (an oscillator or synth with no length).
fn length_seconds(kind: u8, p: impl Fn(usize) -> f32) -> Option<f64> {
    match kind {
        gen::OSCILLATOR => Some(p(gen::osc_p::LENGTH) as f64).filter(|&s| s > 0.0),
        gen::SYNTH => Some(p(gen::synth_p::LENGTH) as f64).filter(|&s| s > 0.0),
        gen::BLIP => {
            use gen::blip::p;
            Some(gen::blip::envelope_seconds(p(p::ATTACK), p(p::SUSTAIN), p(p::DECAY)))
        }
        // Silence: at least a frame (a length of 0 ends at once, unless the voice loops).
        _ => Some(p(gen::silence_p::LENGTH) as f64),
    }
}

/// `seconds` as a key-off frame (at least 1: 0 means none).
#[inline]
fn frames(seconds: f64, rate: f32) -> u32 {
    libm::round(seconds * rate as f64).clamp(1.0, u32::MAX as f64) as u32
}

/// PLAY of voice `voice_id` in slot `index` with clip `clip` (`voices::play`, after it wrote the slot): a generator
/// voice gets its slot record and, but for silence, a pool entry started at its kind's defaults (noise seeded with its
/// id until a GEN seeds it); none free starves it. Another clip leaves the region alone. `slots` are the voice slots
/// (to find free entries).
pub(crate) fn on_play(region: &mut [u8], slots: &[crate::voices::VoiceSlot], index: usize, voice_id: u32, clip: u32) {
    let Some(kind) = kind_of(clip) else { return };
    let Some(v) = view(region) else { return };
    let rate = v.header.sample_rate;
    let Some(slot) = v.slots.get_mut(index) else { return };
    *slot = SlotGen { entry: 0, kind, flags: 0, keyoff_at: 0 };
    let specs = gen::params(kind);
    let default = |i: usize| specs.get(i).map_or(0.0, |s| s.default);
    if kind != gen::SILENCE {
        // A slot taken over gives its own entry back first, so a replacing PLAY reuses it.
        let free = v.entries.iter().position(|e| e.owner as usize == index + 1).or_else(|| v.entries.iter().position(|e| !held(slots, e)));
        if let Some(at) = free {
            let e = &mut v.entries[at];
            e.owner = index as u32 + 1;
            e.id = voice_id;
            e.voice.start(kind, rate, voice_id);
            slot.entry = at as u16 + 1;
            slot.keyoff_at = length_seconds(kind, default).filter(|_| kind != gen::BLIP).map_or(0, |s| frames(s, rate));
            return;
        }
        slot.flags = STARVED;
        v.header.starved = v.header.starved.saturating_add(1);
    }
    slot.keyoff_at = length_seconds(kind, default).map_or(0, |s| frames(s, rate));
}

/// What `voices.rs` renders a generator voice with: its slot record and, when it holds one, its entry's voice.
pub(crate) struct Gen<'a> {
    pub slot: &'a mut SlotGen,
    pub voice: Option<&'a mut GenVoice>,
}

/// Slot `index`'s generator state for voice `voice_id` (`None` without the region or a record).
pub(crate) fn state(region: &mut [u8], index: usize, voice_id: u32) -> Option<Gen<'_>> {
    let v = view(region)?;
    let slot = v.slots.get_mut(index)?;
    if slot.kind == 0 {
        return None;
    }
    let voice = match slot.entry {
        0 => None,
        e => v.entries.get_mut(e as usize - 1).filter(|e| e.owner as usize == index + 1 && e.id == voice_id).map(|e| &mut e.voice),
    };
    Some(Gen { slot, voice })
}

/// SET_LOOP's release on generator voice `voice_id` in slot `index` (`voices::set_loop`): its key-off, now (the
/// scheduler applies a stamped one at its sample).
pub(crate) fn key_off(region: &mut [u8], index: usize, voice_id: u32) {
    if let Some(g) = state(region, index, voice_id) {
        g.slot.flags |= KEYED_OFF;
        if let Some(voice) = g.voice {
            voice.key_off();
        }
    }
}

/// GEN (0x21) at `msg[off..]`, its extent checked by the scheduler ([`is_well_formed`]): see the module comment.
pub fn apply(core: &mut Core, msg: &[u8], off: usize) {
    let voice_id = u32_at(msg, off + 4);
    let Some(index) = crate::voices::live_index(core, voice_id) else { return };
    let s = crate::voices::slots(core)[index];
    if kind_of(s.clip).is_none() {
        return;
    }
    // A voice not started, or silent (a promote just begun), takes the values at once.
    let silent = s.state == crate::voices::state::SCHEDULED || s.mix.value == 0.0;
    let (mask, seed, ramp) = (u32_at(msg, off + 12), u32_at(msg, off + 16), u32_at(msg, off + 20));
    let count = (u32_at(msg, off + 24) as usize).min(gen::PARAMS_MAX);
    let ramp = if silent { 0 } else { ramp };
    let Some(v) = view(&mut core.regions_mut().gen[..]) else { return };
    let rate = v.header.sample_rate;
    let Some(slot) = v.slots.get_mut(index) else { return };
    let kind = slot.kind;
    let specs = gen::params(kind);
    // The masked values, by parameter index (the rest NaN: not set).
    let mut set = [f32::NAN; gen::PARAMS_MAX];
    let mut k = 0usize;
    for (i, x) in set.iter_mut().enumerate() {
        if mask & (1 << i) != 0 && k < count {
            *x = f32::from_le_bytes(msg[off + wire::Gen::FIXED_END + 4 * k..][..4].try_into().unwrap_or([0; 4]));
            k += 1;
        }
    }
    let entry = match slot.entry {
        0 => None,
        e => v.entries.get_mut(e as usize - 1).filter(|e| e.owner as usize == index + 1 && e.id == voice_id).map(|e| &mut e.voice),
    };
    let has = |i: usize| i < specs.len() && mask & (1 << i) != 0 && i < gen::PARAMS_MAX && !set[i].is_nan();
    match entry {
        Some(voice) => {
            for i in 0..specs.len() {
                if has(i) {
                    voice.set(i, set[i], ramp);
                }
            }
            if seed != 0 {
                voice.reseed(seed);
            }
            let length = match kind {
                gen::OSCILLATOR => Some(gen::osc_p::LENGTH),
                gen::SYNTH => Some(gen::synth_p::LENGTH),
                _ => None,
            };
            if let Some(i) = length.filter(|&i| has(i)) {
                let s = voice.value(i) as f64;
                slot.keyoff_at = if s > 0.0 { frames(s, rate) } else { 0 };
            }
        }
        None => {
            // Silence or starved: only its length matters (the GEN's values, else the defaults).
            let value = |i: usize| if has(i) { gen::clamp_param(&specs[i], set[i]) } else { specs.get(i).map_or(0.0, |s| s.default) };
            slot.keyoff_at = length_seconds(kind, value).map_or(0, |s| frames(s, rate));
        }
    }
}

/// `true` when the GEN record at `msg[off..off + len]` holds its values (at most `GEN_PARAMS_MAX`).
pub fn is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::Gen::FIXED_END || off + len > msg.len() {
        return false;
    }
    let n = u32_at(msg, off + 24) as usize;
    n <= gen::PARAMS_MAX && wire::Gen::FIXED_END + 4 * n <= len
}

/// AUTOMATE target 5 (`automation::begin_quantum`): parameter `param` of generator voice `voice_id` in slot `index`
/// takes `value`, glided over the quantum (at once when `jump`: a voice not started, or the binding just made).
pub(crate) fn automate(region: &mut [u8], index: usize, voice_id: u32, param: usize, value: f32, jump: bool) {
    if let Some(Gen { voice: Some(voice), .. }) = state(region, index, voice_id) {
        voice.set(param, value, if jump { 0 } else { crate::QUANTUM as u32 });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_are_the_reserved_ids_one_to_four() {
        assert_eq!(kind_of(wire::GEN_CLIP_ID_FIRST), None);
        assert_eq!(kind_of(wire::GEN_CLIP_ID_FIRST + 1), Some(gen::OSCILLATOR));
        assert_eq!(kind_of(wire::GEN_CLIP_ID_FIRST + 4), Some(gen::SILENCE));
        assert_eq!(kind_of(wire::GEN_CLIP_ID_FIRST + 5), None);
        assert_eq!(kind_of(1), None);
        assert_eq!(kind_of(wire::HRIR_CLIP_ID_FIRST + 1), None);
    }

    #[test]
    fn the_pool_is_a_quarter_of_the_mixed_voices_at_least_16() {
        let p = |m: u32| InitParams { max_mixed: m, ..InitParams::default() };
        assert_eq!(entries_for(&p(48)), 16);
        assert_eq!(entries_for(&p(128)), 32);
        assert_eq!(entries_for(&p(256)), 64);
        let bytes = region_bytes(&InitParams { max_logical: 4_096, max_mixed: 256, ..InitParams::default() });
        eprintln!("entry {} B; high preset's region {bytes} B", ENTRY_BYTES);
        assert!(ENTRY_BYTES < 6 * 1024, "{ENTRY_BYTES}");
        assert!(bytes < 64 * 6 * 1024 + 4_096 * 8 + 128, "{bytes}");
    }
}
