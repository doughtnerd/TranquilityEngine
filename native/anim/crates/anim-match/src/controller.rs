//! The matching controller: when to search, and when a search result becomes a switch (runtime;
//! fixed size, never allocates).
//!
//! Each [`update`](MatchController::update) advances the playing clip time by `dt` and finds the
//! database frame it now plays (the *continuation*: [`MatchDb::frame_at`]). It searches when
//!
//! - nothing plays yet, or the continuation left the database (a run ended: a one-shot clip's
//!   last searchable frame, a looping clip's end, a range's end), or no longer passes the tag
//!   filter;
//! - `search_interval` updates passed since the last search; or
//! - the query's trajectory moved away from the continuation's by more than `force_threshold`
//!   (the weighted trajectory cost; a large change in what the player asks for).
//!
//! A search skips the continuation's own neighbourhood (`ignore_neighbours` frames either side,
//! same clip). It switches to the best frame when the continuation is gone or filtered out, or
//! when both hold (Clavet, GDC 2016):
//!
//! - `best.cost < continuation cost − continuation_bias` (keep playing unless the best is
//!   clearly better), and
//! - at least `min_switch_interval` seconds passed since the last switch.
//!
//! A switch is a request: the output's `switched` flag with the target clip and time, which the
//! host or graph plays from with an inertialized transition (`anim_pose::inertialize`, D19).

use crate::db::{MatchDb, TagFilter};
use crate::search::{Match, SearchFilter, SearchMode, Skip};
use anim_format::NONE;
use anim_math::F32x4;

/// Controller options.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ControllerSettings {
    /// Search every this many updates (≥ 1). Default 6.
    pub search_interval: u32,
    /// The trajectory cost that forces a search at once. Default 2.
    pub force_threshold: f32,
    /// How much cheaper the best frame must be than the continuation to switch. Default 0.1.
    pub continuation_bias: f32,
    /// Seconds between switches (unless the continuation is gone). Default 0.2.
    pub min_switch_interval: f32,
    /// Frames either side of the continuation (same clip) a search skips. Default 6.
    pub ignore_neighbours: u32,
    /// Default [`SearchMode::KdTree`].
    pub mode: SearchMode,
}

impl Default for ControllerSettings {
    fn default() -> Self {
        Self {
            search_interval: 6,
            force_threshold: 2.0,
            continuation_bias: 0.1,
            min_switch_interval: 0.2,
            ignore_neighbours: 6,
            mode: SearchMode::KdTree,
        }
    }
}

/// What an update decided.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MatchOutput {
    /// Play from (`clip`, `time`) now, with an inertialized transition.
    pub switched: bool,
    /// A search ran this update.
    pub searched: bool,
    /// The playing clip (database clip index), or `NONE` when nothing plays.
    pub clip: u32,
    /// The playing time in it, seconds.
    pub time: f32,
    /// The database frame playing, or `NONE`.
    pub frame: u32,
    /// The playing frame's cost against the query (when a search ran or a switch happened; else
    /// the last one).
    pub cost: f32,
}

/// The controller's state.
#[derive(Clone, Copy, Debug)]
pub struct MatchController {
    pub settings: ControllerSettings,
    clip: u32,
    time: f32,
    frame: u32,
    cost: f32,
    since_search: u32,
    since_switch: f32,
}

impl MatchController {
    /// A controller playing nothing.
    pub fn new(settings: ControllerSettings) -> Self {
        Self {
            settings,
            clip: NONE,
            time: 0.0,
            frame: NONE,
            cost: f32::INFINITY,
            since_search: 0,
            since_switch: f32::INFINITY,
        }
    }

    /// Plays nothing again (the next update searches and switches).
    pub fn reset(&mut self) {
        *self = Self::new(self.settings);
    }

    /// `u32` words of [`write_words`](Self::write_words): the state without the settings, as plain
    /// words, so a graph instance can keep it in its state blob (snapshot and restore are a copy).
    pub const WORDS: usize = 6;

    /// Writes the state (not the settings) into `out` ([`WORDS`](Self::WORDS) long), bit for bit.
    pub fn write_words(&self, out: &mut [u32]) {
        out[..Self::WORDS].copy_from_slice(&[
            self.clip,
            self.time.to_bits(),
            self.frame,
            self.cost.to_bits(),
            self.since_search,
            self.since_switch.to_bits(),
        ]);
    }

    /// A controller with `settings` and the state [`write_words`](Self::write_words) wrote (`words`
    /// at least [`WORDS`](Self::WORDS) long, else one playing nothing).
    pub fn read_words(settings: ControllerSettings, words: &[u32]) -> Self {
        if words.len() < Self::WORDS {
            return Self::new(settings);
        }
        Self {
            settings,
            clip: words[0],
            time: f32::from_bits(words[1]),
            frame: words[2],
            cost: f32::from_bits(words[3]),
            since_search: words[4],
            since_switch: f32::from_bits(words[5]),
        }
    }

    /// The playing clip and time, if any.
    pub fn playing(&self) -> Option<(u32, f32)> {
        (self.clip != NONE).then_some((self.clip, self.time))
    }

    /// Advances `dt` seconds and decides, with `query` (`db.lanes()` long) and `tags`.
    pub fn update(
        &mut self,
        db: &MatchDb,
        dt: f32,
        query: &[F32x4],
        tags: &TagFilter,
    ) -> MatchOutput {
        let dt = if dt.is_finite() { dt.max(0.0) } else { 0.0 };
        let s = self.settings;
        let mut cont = None;
        if self.clip != NONE {
            self.time += dt;
            self.since_switch += dt;
            cont = db
                .frame_at(self.clip, self.time)
                .filter(|&f| db.passes(f as usize, tags));
        }
        self.since_search = self.since_search.saturating_add(1);
        let forced = match cont {
            None => true,
            Some(f) => db.trajectory_cost(query, f as usize) > s.force_threshold,
        };
        let mut out = MatchOutput {
            switched: false,
            searched: false,
            clip: self.clip,
            time: self.time,
            frame: cont.unwrap_or(NONE),
            cost: self.cost,
        };
        if !(forced || self.since_search >= s.search_interval.max(1)) {
            self.frame = out.frame;
            return out;
        }
        self.since_search = 0;
        out.searched = true;
        let skip = cont.map(|f| Skip {
            clip: self.clip,
            first: f.saturating_sub(s.ignore_neighbours),
            last: f.saturating_add(s.ignore_neighbours),
        });
        let filter = SearchFilter { tags: *tags, skip };
        let best = db.search(query, &filter, s.mode);
        let current = cont.map(|f| db.cost(query, f as usize));
        let switch = match (best, current) {
            (Some(_), None) => true,
            (Some(b), Some(c)) => {
                self.since_switch >= s.min_switch_interval && b.cost < c - s.continuation_bias
            }
            (None, _) => false,
        };
        if let (
            true,
            Some(Match {
                frame,
                cost,
                clip,
                time,
            }),
        ) = (switch, best)
        {
            self.clip = clip;
            self.time = time;
            self.frame = frame;
            self.cost = cost;
            self.since_switch = 0.0;
            out.switched = true;
            out.clip = clip;
            out.time = time;
            out.frame = frame;
            out.cost = cost;
        } else {
            self.frame = out.frame;
            if let Some(c) = current {
                self.cost = c;
                out.cost = c;
            }
        }
        out
    }
}
