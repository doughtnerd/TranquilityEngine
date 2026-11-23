//! Bus-to-return sends (ADR 0344 "returns and sends", decision D29 #1 and #7; ABI 4.7).
//!
//! - **BUS_SENDS** (0x1E, asap, replace-all for one bus: `voiceId` is its slot) gives a bus up to
//!   [`MAX_SENDS`] post-fader sends, each into another bus slot (a return: an ordinary bus with its
//!   own inserts, fader and output), with a linear `level` reached over `frames`. A send whose `to`
//!   it had before keeps its ramp (an edit glides from where it is); a new one starts at 0 and ramps
//!   up. `BUS_SEND_MUTED` ramps the send to 0 and keeps its level (core-side send muting: a muted
//!   bus or return, a solo, a monitor mute).
//! - **Render** (`bus::mixdown`, [`feed`]): after the bus's gain stage, each send adds
//!   `gain · signal` (the gain ramped per frame) into its return's input. The return mixes after
//!   every bus that sends into it (`bus_order::rerun` adds a `bus → return` edge per send); a send
//!   whose edge would close a cycle feeds the return's next quantum. A send into itself, out of
//!   range, or into the master output's own index is ignored.
//! - **RESET** lands every send's ramp on its target (main's intent stays).
//!
//! Runs `on_sends` in `onmessage`; [`feed`] inside `process`. Nothing allocates.

use audio_dsp::ramp::Ramp;
use audio_wire::generated as wire;

use crate::automation::BusAuto;
use crate::bus::{self, BusSlot};
use crate::core::Core;
use crate::wire_read::{u16_at, u32_at};

/// Sends a bus keeps (the wire's `MAX_BUS_SENDS`).
pub const MAX_SENDS: usize = wire::MAX_BUS_SENDS as usize;
/// A send's level ceiling (+12 dB), as `BUS_RAMP`'s gain.
pub const MAX_LEVEL: f32 = 4.0;

/// One send. All-zero is no send.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BusSend {
    /// The receiving bus slot.
    pub to: u16,
    /// The wire's flags (`BUS_SEND_MUTED`).
    pub flags: u16,
    /// The level as last received.
    pub level: f32,
    /// The gain applied, ramping to `level` (or 0 while muted).
    pub gain: Ramp,
}

/// A bus's sends. All-zero is none.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Sends {
    pub count: u32,
    pub list: [BusSend; MAX_SENDS],
}

impl Sends {
    /// The sends in use.
    pub fn used(&self) -> &[BusSend] {
        &self.list[..(self.count as usize).min(MAX_SENDS)]
    }
}

/// `true` when the BUS_SENDS record at `msg[off..off + len]` holds its sends.
pub fn is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::BusSends::FIXED_END || off + len > msg.len() {
        return false;
    }
    let n = u32_at(msg, off + 12) as usize;
    n.checked_mul(wire::BusSendsSends::FIXED_END).is_some_and(|b| wire::BusSends::FIXED_END + b <= len)
}

/// Replaces `slot`'s sends with `items` `(to, flags, level, frames)` (see the module comment).
pub fn replace(slot: &mut BusSlot, items: impl Iterator<Item = (u16, u16, f32, u32)>) -> u32 {
    let old = slot.sends;
    let mut out = Sends::default();
    let mut dropped = 0;
    for (to, flags, level, frames) in items {
        let n = out.count as usize;
        if n >= MAX_SENDS {
            dropped += 1;
            continue;
        }
        let level = if level.is_finite() { level.clamp(0.0, MAX_LEVEL) } else { 0.0 };
        let mut gain = old.used().iter().find(|s| s.to == to).map_or(Ramp::at(0.0), |s| s.gain);
        let target = if flags & wire::BUS_SEND_MUTED as u16 != 0 { 0.0 } else { level };
        if gain.target != target || !gain.is_settled() {
            gain.set_target(target, frames);
        }
        out.list[n] = BusSend { to, flags, level, gain };
        out.count += 1;
    }
    slot.sends = out;
    dropped
}

/// BUS_SENDS: replaces bus `voiceId`'s sends, then re-runs the mix order (a send orders its return
/// after the sender). A bus past the configured ones is ignored and counted as dropped.
pub fn on_sends(core: &mut Core, msg: &[u8], off: usize) {
    let index = u32_at(msg, off + 4) as usize;
    let n = u32_at(msg, off + 12) as usize;
    let v = bus::view(core.regions_mut());
    let count = (v.area.count as usize).min(v.slots.len());
    if index >= count {
        v.area.dropped = v.area.dropped.wrapping_add(n as u32);
        return;
    }
    let items = (0..n).map(|i| {
        let at = off + wire::BusSends::FIXED_END + i * wire::BusSendsSends::FIXED_END;
        (u16_at(msg, at), u16_at(msg, at + 2), f32::from_bits(u32_at(msg, at + 4)), u32_at(msg, at + 8))
    });
    let dropped = replace(&mut v.slots[index], items);
    v.area.dropped = v.area.dropped.wrapping_add(dropped);
    crate::bus_order::rerun(core);
}

/// The `(from, to)` order edges of every bus's sends (into `out`; returns how many).
pub fn edges(slots: &[BusSlot], out: &mut [(u8, u8)]) -> usize {
    let mut n = 0;
    for (b, s) in slots.iter().enumerate() {
        for send in s.sends.used() {
            let to = send.to as usize;
            if to < slots.len() && to != b && n < out.len() {
                out[n] = (b as u8, to as u8);
                n += 1;
            }
        }
    }
    n
}

/// Inside `mixdown`, after bus `b`'s gain stage: adds each of its sends (`block`: its post-fader
/// quantum, planar stereo) into the receiving buses' inputs, stepping the send ramps. ABI 4.8: a
/// send its bus's automation drives (`auto`, [`BusAuto::send_gain`]) is multiplied by that gain too,
/// ramped across the quantum.
pub(crate) fn feed(slots: &mut [BusSlot], b: usize, block: &[f32], auto: Option<&BusAuto>) {
    let q = crate::QUANTUM;
    let n = (slots[b].sends.count as usize).min(MAX_SENDS);
    for i in 0..n {
        let mut send = slots[b].sends.list[i];
        let to = send.to as usize;
        if to >= slots.len() || to == b {
            continue;
        }
        if send.gain.is_settled() && send.gain.value == 0.0 {
            continue;
        }
        let (dl, dr) = slots[to].buf.split_at_mut(q);
        if let Some((a0, a1)) = auto.and_then(|a| a.send_gain(send.to)) {
            for k in 0..q {
                let g = send.gain.next() * crate::automation::ramp_at(a0, a1, k);
                dl[k] += g * block[k];
                dr[k] += g * block[q + k];
            }
        } else if send.gain.is_settled() {
            let g = send.gain.value;
            for k in 0..q {
                dl[k] += g * block[k];
                dr[k] += g * block[q + k];
            }
        } else {
            for k in 0..q {
                let g = send.gain.next();
                dl[k] += g * block[k];
                dr[k] += g * block[q + k];
            }
        }
        slots[b].sends.list[i].gain = send.gain;
    }
}

/// RESET: every send's ramp lands on its target.
pub fn settle(slot: &mut BusSlot) {
    let n = (slot.sends.count as usize).min(MAX_SENDS);
    for s in slot.sends.list[..n].iter_mut() {
        s.gain = Ramp::at(s.gain.target);
    }
}
