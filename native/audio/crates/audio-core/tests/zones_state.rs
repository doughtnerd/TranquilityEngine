//! The zone slot state machine (ADR 0162 C3, leaf L-C3a; contracts C5, C7, OD2; api-and-models §9
//! "zone slot machine (waiting kernel, fade in, active, release, ring out, off, refused)"): every
//! ZONE_CONFIG transition of `zones.rs`'s table, the STATUS `zones`/`zoneEvents` it reports, and
//! both slot paths: the standby slot (high and default: 3 slots, a released zone rings out in its
//! own slot while the incoming zone takes the spare) and the eviction fade (low: 1 slot, the
//! outgoing zone fades out over 150 ms before the incoming one takes the slot).
//!
//! Helpers are in `zones_common` (a core with zone slots, kernels uploaded as format 3 clips,
//! ZONE_CONFIG records, slot input fed directly).

mod zones_common;

#[allow(unused_imports)]
use audio_core::{status, zones, QUANTUM};
#[allow(unused_imports)]
use zones_common::*;

#[test]
#[ignore = "L-C3a"]
fn an_active_slot_waits_for_its_kernel_and_is_silent() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn the_kernel_arriving_starts_the_slot_fading_in_over_100_ms() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn a_resident_kernel_starts_fading_in_on_arrival_of_zone_config() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn a_faded_in_slot_is_active_and_a_repeated_config_changes_nothing() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn wet_ramps_without_restarting_the_slot() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn release_ignores_sends_and_rings_out_then_the_slot_is_off() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn a_ringing_slot_set_active_again_is_active_without_a_new_fade() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn release_or_evict_of_a_waiting_slot_turns_it_off() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn kernel_id_zero_fades_an_active_slot_out_instead_of_cutting_it() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn a_new_kernel_in_a_slot_that_is_not_off_is_refused_once() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn a_slot_past_max_zone_slots_is_refused() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn a_bad_kernel_blob_is_reported_once_and_the_slot_keeps_waiting() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn evict_fades_out_over_150_ms_then_the_slot_is_off() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn low_preset_swaps_zones_with_the_eviction_fade() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn high_and_default_presets_swap_zones_through_the_standby_slot() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn reset_turns_every_slot_off() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn status_reports_every_slot_and_the_counts() {
    todo!("L-C3a")
}

#[test]
#[ignore = "L-C3a"]
fn freeing_a_running_slots_kernel_sends_it_back_to_waiting() {
    todo!("L-C3a")
}
