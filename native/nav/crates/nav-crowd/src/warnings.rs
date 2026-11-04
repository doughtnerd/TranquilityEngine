//! Warnings and log lines for the host (Foxfire's `NavWarnings` / `NavWarningSystem`, and the `Debug.Log` /
//! `LogWarning` calls of its systems).
//!
//! Steps report path and route failures as a [`NavWarning`] (a kind and numbers, as Foxfire's jobs do); at most
//! [`PER_SECOND`] a second become messages, the rest are counted and reported once a second as held back
//! ([`Warnings::end_tick`], the last step of a tick, `NavWarningSystem` with `OrderLast`). One-off warnings (an agent
//! type with nothing baked, a failed overlay build) go straight in with [`Warnings::warn_text`]; informational lines
//! (route graphs rebuilt, the seam report) with [`Warnings::log`]. The host drains both lists each tick
//! ([`crate::Crowd::drain_warnings`], [`crate::Crowd::drain_logs`]) and prints them to the console.
//!
//! Single-threaded: no lock-free slots as in the C#, just a counter.
use nav_math::{Float3, Float4, Int2, Int4};

/// `NavWarnings.PerSecond`.
pub const PER_SECOND: usize = 5;
/// Most messages kept undrained; older ones are dropped (a host that never drains doesn't grow without bound).
pub const MAX_QUEUED: usize = 256;

/// `NavWarningKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavWarningKind {
    /// a = start, f.x = max snap distance.
    PathStartOffMesh,
    /// a = goal, f.x = max snap distance.
    PathGoalOffMesh,
    /// n = start poly, goal poly, status.
    PathRejected,
    /// a = start, b = goal, f.x = max snap distance.
    FlightOffVolume,
    /// a = start, b = goal.
    RouteOffMesh,
    /// f = ms total, snap, A*, write; n = frame of its search, located before, finished, heap pops; m = nodes, open.
    SlowPathStep,
}

/// `NavWarning`: a warning's kind and the numbers its message needs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavWarning {
    pub kind: NavWarningKind,
    pub a: Float3,
    pub b: Float3,
    pub f: Float4,
    pub n: Int4,
    pub m: Int2,
}

impl NavWarning {
    pub fn new(kind: NavWarningKind) -> Self {
        Self { kind, a: Float3::default(), b: Float3::default(), f: Float4::default(), n: Int4::default(), m: Int2::default() }
    }

    /// `NavWarningSystem.Message`.
    pub fn message(&self) -> String {
        let (a, b, f, n, m) = (self.a, self.b, self.f, self.n, self.m);
        match self.kind {
            NavWarningKind::PathStartOffMesh => {
                format!("Nav path failed: start ({}, {}, {}) is more than MaxSnapDistance ({}) from any usable polygon", a.x, a.y, a.z, f.x)
            }
            NavWarningKind::PathGoalOffMesh => {
                format!("Nav path failed: goal ({}, {}, {}) is more than MaxSnapDistance ({}) from any usable polygon", a.x, a.y, a.z, f.x)
            }
            NavWarningKind::PathRejected => {
                format!("Nav path failed: search rejected start poly {} / goal poly {} (status {}, 0 waypoints)", n.x, n.y, n.z)
            }
            NavWarningKind::FlightOffVolume => format!(
                "Flight path failed: start ({}, {}, {}) or goal ({}, {}, {}) is more than MaxSnapDistance ({}) from free space",
                a.x, a.y, a.z, b.x, b.y, b.z, f.x
            ),
            NavWarningKind::RouteOffMesh => format!(
                "Nav route failed: start ({}, {}, {}) or goal ({}, {}, {}) is off the navmesh and outside the flight volume (more than MaxSnapDistance away)",
                a.x, a.y, a.z, b.x, b.y, b.z
            ),
            NavWarningKind::SlowPathStep => format!(
                "Nav path search step took {:.1} ms (snap {:.1}, A* {:.1}, write {:.1}): frame {} of its search, located before {}, finished {}, {} heap pops this step, {} nodes, {} open",
                f.x, f.y, f.z, f.w, n.x, n.y, n.z, n.w, m.x, m.y
            ),
        }
    }
}

/// The crowd's warning and log queues (see the module doc).
#[derive(Clone, Debug, Default)]
pub struct Warnings {
    label: String,
    warnings: Vec<String>,
    logs: Vec<String>,
    /// Rate-limited warnings this second.
    this_second: usize,
    held: usize,
    next_reset: f64,
    /// Every rate-limited warning offered, shown or not (for tests and the debug panel).
    pub offered: u64,
}

impl Warnings {
    pub fn new(label: &str) -> Self {
        Self { label: label.to_string(), ..Self::default() }
    }

    /// The world label lines carry (`Navigation [world]: ...`).
    pub fn label(&self) -> &str {
        &self.label
    }

    /// `NavWarnings.Add`: queues a rate-limited warning. False if this second's budget is spent (counted as held back).
    pub fn add(&mut self, warning: &NavWarning) -> bool {
        self.offered += 1;
        if self.this_second >= PER_SECOND {
            self.held += 1;
            return false;
        }
        self.this_second += 1;
        let text = warning.message();
        Self::push(&mut self.warnings, text);
        true
    }

    /// A warning that isn't rate-limited (one-off conditions the step itself throttles).
    pub fn warn_text(&mut self, text: String) {
        Self::push(&mut self.warnings, text);
    }

    /// An informational line.
    pub fn log(&mut self, text: String) {
        Self::push(&mut self.logs, text);
    }

    fn push(list: &mut Vec<String>, text: String) {
        if list.len() >= MAX_QUEUED {
            list.remove(0);
        }
        list.push(text);
    }

    /// `NavWarningSystem.OnUpdate`'s second boundary: once a second, start a new budget and report what was held back.
    pub fn end_tick(&mut self, time: f64) {
        if time < self.next_reset {
            return;
        }
        self.next_reset = time + 1.0;
        self.this_second = 0;
        let held = std::mem::take(&mut self.held);
        if held > 0 {
            let text = format!("Navigation [{}]: {held} more path warnings in the last second not shown (at most {PER_SECOND} a second).", self.label);
            Self::push(&mut self.warnings, text);
        }
    }

    pub fn drain_warnings(&mut self) -> Vec<String> {
        std::mem::take(&mut self.warnings)
    }

    pub fn drain_logs(&mut self) -> Vec<String> {
        std::mem::take(&mut self.logs)
    }

    /// Warnings waiting to be drained.
    pub fn pending_warnings(&self) -> &[String] {
        &self.warnings
    }

    pub fn pending_logs(&self) -> &[String] {
        &self.logs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_most_five_a_second_then_the_rest_are_reported_as_held_back() {
        let mut w = Warnings::new("test");
        w.end_tick(0.0); // starts the first second
        let mut warning = NavWarning::new(NavWarningKind::PathGoalOffMesh);
        warning.f.x = 2.0;
        let shown = (0..12).filter(|_| w.add(&warning)).count();
        assert_eq!(shown, PER_SECOND);
        assert_eq!(w.drain_warnings().len(), PER_SECOND);
        w.end_tick(0.5);
        assert!(w.pending_warnings().is_empty(), "not a second yet");
        w.end_tick(1.0);
        let report = w.drain_warnings();
        assert_eq!(report.len(), 1);
        assert!(report[0].contains("7 more path warnings"), "{}", report[0]);
        assert!(w.add(&warning), "a new second's budget");
        assert!(w.drain_warnings()[0].contains("MaxSnapDistance (2)"));
        w.end_tick(2.0);
        assert!(w.drain_warnings().is_empty(), "nothing held back: no report");
        assert_eq!(w.offered, 13);
    }
}
