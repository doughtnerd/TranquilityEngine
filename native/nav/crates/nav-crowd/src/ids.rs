//! Handles and the slot table behind them.
//!
//! Foxfire's agents, obstacles and groups are entities; here each kind lives in a [`SlotTable`]: a slot index (the
//! row of every per-agent array and of the boundary buffers, see [`crate::boundary`]) plus a generation that changes
//! each time the slot is freed, so a stale handle never reaches the slot's next occupant. Freed slots are reused
//! lowest index first, which keeps the boundary buffers dense.
use std::fmt;

/// A slot index and its generation. Generation 0 is never handed out, so `Handle::default()` is never valid.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Handle {
    pub index: u32,
    pub generation: u32,
}

impl Handle {
    pub const NONE: Handle = Handle { index: u32::MAX, generation: 0 };

    pub const fn new(index: u32, generation: u32) -> Self {
        Self { index, generation }
    }

    /// The row in the per-slot arrays and boundary buffers.
    #[inline]
    pub fn row(self) -> usize {
        self.index as usize
    }

    /// Packed for the boundary: `generation << 32 | index`, as one `u64` (a JS `BigInt`, or two `u32`s).
    pub fn to_bits(self) -> u64 {
        (self.generation as u64) << 32 | self.index as u64
    }

    pub fn from_bits(bits: u64) -> Self {
        Self { index: bits as u32, generation: (bits >> 32) as u32 }
    }
}

macro_rules! handle_type {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(pub Handle);

        impl $name {
            pub const NONE: $name = $name(Handle::NONE);
            #[inline]
            pub fn row(self) -> usize {
                self.0.row()
            }
            #[inline]
            pub fn index(self) -> u32 {
                self.0.index
            }
            #[inline]
            pub fn generation(self) -> u32 {
                self.0.generation
            }
            pub fn to_bits(self) -> u64 {
                self.0.to_bits()
            }
            pub fn from_bits(bits: u64) -> Self {
                Self(Handle::from_bits(bits))
            }
            #[inline]
            pub fn is_none(self) -> bool {
                self.0.generation == 0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}#{}v{}", stringify!($name), self.0.index, self.0.generation)
            }
        }
    };
}

handle_type!(
    /// An agent (Foxfire: an entity with `NavMeshAgentConfig` and/or `NavFlightAgentConfig`). Group bodies are agents
    /// too (a `NavGroup` entity is a virtual walker or flyer), so a group's handle is an `AgentId`.
    AgentId
);
handle_type!(
    /// A moving or still obstacle for avoidance (`NavAvoidanceObstacle`).
    ObstacleId
);

/// A target the host names: something agents chase, surround or flow to that isn't necessarily an agent (a node of the
/// TS scene). Its position arrives each tick in [`crate::world::WorldInput::targets`]. Chosen by the host.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TargetId(pub u32);

/// What an agent chases (`PathGoalTarget.Target`): another agent, or a host target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TargetRef {
    Agent(AgentId),
    Target(TargetId),
}

/// The state of one slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotState {
    /// Free (on the free list).
    Free,
    /// Handed out by `reserve`, not yet live: its add command hasn't been applied (a tick hasn't started).
    Reserved,
    Live,
}

/// Index + generation slots (see the module doc). Doesn't own the per-slot data: the owner keeps arrays indexed by
/// [`Handle::row`] and grows them to [`SlotTable::capacity`].
#[derive(Clone, Debug, Default)]
pub struct SlotTable {
    generations: Vec<u32>,
    states: Vec<SlotState>,
    /// Free slots, kept sorted descending so `pop` gives the lowest index.
    free: Vec<u32>,
    live: usize,
}

impl SlotTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Slots ever made (the length the per-slot arrays need).
    pub fn capacity(&self) -> usize {
        self.generations.len()
    }

    /// Live slots.
    pub fn len(&self) -> usize {
        self.live
    }

    pub fn is_empty(&self) -> bool {
        self.live == 0
    }

    /// Hands out a slot (the lowest free one, else a new one) as `Reserved`. Returns the handle and whether the table
    /// grew (the owner must grow its arrays).
    pub fn reserve(&mut self) -> (Handle, bool) {
        if let Some(index) = self.free.pop() {
            let i = index as usize;
            self.states[i] = SlotState::Reserved;
            return (Handle::new(index, self.generations[i]), false);
        }
        let index = self.generations.len() as u32;
        self.generations.push(1);
        self.states.push(SlotState::Reserved);
        (Handle::new(index, 1), true)
    }

    /// A reserved slot becomes live. False if the handle is stale or the slot isn't reserved.
    pub fn activate(&mut self, h: Handle) -> bool {
        if self.state(h) != Some(SlotState::Reserved) {
            return false;
        }
        self.states[h.row()] = SlotState::Live;
        self.live += 1;
        true
    }

    /// Frees a reserved or live slot: its generation moves on, so every handle to it goes stale. False if stale.
    pub fn free(&mut self, h: Handle) -> bool {
        let Some(state) = self.state(h) else { return false };
        if state == SlotState::Free {
            return false;
        }
        if state == SlotState::Live {
            self.live -= 1;
        }
        let i = h.row();
        self.states[i] = SlotState::Free;
        self.generations[i] = self.generations[i].wrapping_add(1).max(1);
        let pos = self.free.partition_point(|&f| f > h.index);
        self.free.insert(pos, h.index);
        true
    }

    /// The slot's state if `h` is current (its generation matches), else None.
    pub fn state(&self, h: Handle) -> Option<SlotState> {
        let i = h.row();
        (i < self.generations.len() && self.generations[i] == h.generation && h.generation != 0).then(|| self.states[i])
    }

    /// True if `h` names a live slot.
    #[inline]
    pub fn is_live(&self, h: Handle) -> bool {
        self.state(h) == Some(SlotState::Live)
    }

    /// True if row `i` is live (whatever handle names it).
    #[inline]
    pub fn row_live(&self, i: usize) -> bool {
        self.states.get(i) == Some(&SlotState::Live)
    }

    /// The current handle of row `i`, if live.
    pub fn handle_of(&self, i: usize) -> Option<Handle> {
        self.row_live(i).then(|| Handle::new(i as u32, self.generations[i]))
    }

    /// Live rows, ascending.
    pub fn live_rows(&self) -> impl Iterator<Item = usize> + '_ {
        self.states.iter().enumerate().filter(|(_, s)| **s == SlotState::Live).map(|(i, _)| i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuse_bumps_generation_and_takes_lowest_free() {
        let mut t = SlotTable::new();
        let (a, grew) = t.reserve();
        assert!(grew);
        let (b, _) = t.reserve();
        let (c, _) = t.reserve();
        for h in [a, b, c] {
            assert!(t.activate(h));
        }
        assert_eq!(t.len(), 3);
        assert!(t.free(c));
        assert!(t.free(a));
        assert!(!t.free(a), "already freed");
        assert!(!t.is_live(a));
        let (d, grew) = t.reserve();
        assert!(!grew);
        assert_eq!(d.index, a.index, "lowest free slot first");
        assert_eq!(d.generation, a.generation + 1);
        assert_eq!(t.state(a), None, "stale handle");
        assert_eq!(t.state(d), Some(SlotState::Reserved));
        assert!(!t.activate(a));
        assert!(t.activate(d));
        assert_eq!(t.live_rows().collect::<Vec<_>>(), vec![0, 1]);
        assert_eq!(Handle::from_bits(d.to_bits()), d);
        assert_eq!(t.state(Handle::default()), None);
    }
}
