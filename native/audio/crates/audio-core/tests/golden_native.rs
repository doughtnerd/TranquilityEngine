//! Native goldens for the core's voices (ADR 0157, api-and-models §8; task A1.2, leaf A1.2-L4).
//!
//! Each scenario builds a `Core` over a zeroed, page-aligned block, puts a generated clip in its
//! `ClipStore`, submits BATCH messages written with `audio-wire`'s generated writers through
//! `audio_core::scheduler::submit` (the path `myco_audio_submit` takes), renders quanta with
//! `Core::process`, and checks the samples against values computed here from the spec. A2.7 later
//! adds the Vitest wasm layer; these stay (plan, F7).

#[test]
#[ignore = "A1.2-L4"]
fn one_shot_plays_its_clip_once_then_ends() {}

#[test]
#[ignore = "A1.2-L4"]
fn gain_scales_the_clip() {}

#[test]
#[ignore = "A1.2-L4"]
fn a_virtual_voice_is_silent_but_ends_on_time() {}

#[test]
#[ignore = "A1.2-L4"]
fn pitch_two_plays_every_other_frame() {}

#[test]
#[ignore = "A1.2-L4"]
fn pitch_half_interpolates_between_frames() {}

#[test]
#[ignore = "A1.2-L4"]
fn a_clip_at_half_the_context_rate_plays_at_half_speed() {}

#[test]
#[ignore = "A1.2-L4"]
fn a_loop_wraps_seamlessly_and_never_ends() {}

#[test]
#[ignore = "A1.2-L4"]
fn stop_ends_a_loop_at_the_next_quantum() {}

#[test]
#[ignore = "A1.2-L4"]
fn stop_with_a_fade_ramps_to_silence_then_ends() {}

#[test]
#[ignore = "A1.2-L4"]
fn fade_with_stop_at_end_ends_the_voice() {}

#[test]
#[ignore = "A1.2-L4"]
fn set_params_gain_ramps_over_ramp_frames() {}

#[test]
#[ignore = "A1.2-L4"]
fn a_stamped_play_starts_at_its_sample_offset() {}

#[test]
#[ignore = "A1.2-L4"]
fn a_late_stamped_play_starts_at_once_and_counts_late() {}

#[test]
#[ignore = "A1.2-L4"]
fn a_stamped_stop_cuts_at_its_sample_offset() {}

#[test]
#[ignore = "A1.2-L4"]
fn a_spatial_source_pans_with_blinks_equal_power_gains() {}

#[test]
#[ignore = "A1.2-L4"]
fn a_moving_source_ramps_from_left_to_right() {}

#[test]
#[ignore = "A1.2-L4"]
fn a_new_generation_replaces_the_voice_in_its_slot() {}

#[test]
#[ignore = "A1.2-L4"]
fn process_never_allocates() {}
