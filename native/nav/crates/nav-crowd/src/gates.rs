//! Gates (Foxfire's `NavGateSystem` and the gate table entities): every loaded chunk's gate table kept in step with
//! the world's gates.
//!
//! A gate is named by its id (`NavGate.Id`); gate indices are per bake, so each chunk's table (`NavGateTableEntry`,
//! entry 0 unused) is matched by id. A table that has just loaded takes every gate's current state first (a gate may
//! have changed while its chunk was unloaded); after that only gates that changed are applied, and a table whose
//! states change records the time (`NavGateTable.LastChange`), so paths through it repath.
//!
//! Foxfire runs this system before the repath systems, anywhere in the frame; here it runs first, at the start of the
//! chunk step, right after the tick's commands (`SetGate`) are applied, so this tick's snapshot already has the new
//! states. Gates a chunk doesn't know are remembered for chunks loaded later.
use nav_format::file::BakeFile;
use nav_math::Hash128;
use nav_query::chunks::GateState;
use std::collections::BTreeMap;

/// One chunk's gate table (`NavGateTable` with its buffers).
#[derive(Clone, Debug, Default)]
pub struct GateTable {
    /// `NavGateTableEntry`: gate index -> id (entry 0 unused).
    pub ids: Vec<Hash128>,
    /// `NavGateClosed`: by gate index.
    pub closed: Vec<bool>,
    pub last_change: f64,
    /// `NavGateTableSynced`: brought in step with the world's gates since it loaded.
    pub synced: bool,
}

impl GateTable {
    /// The bake's table with its starting states.
    pub fn from_file(file: &BakeFile) -> Self {
        match &file.gate_table {
            Some(t) => Self { ids: t.ids.clone(), closed: t.closed.iter().map(|&c| c != 0).collect(), last_change: 0.0, synced: false },
            None => Self::default(),
        }
    }

    fn index_of(&self, id: Hash128) -> Option<usize> {
        (1..self.ids.len()).find(|&i| self.ids[i] == id)
    }

    /// `Apply`: writes the given gates' states; stamps the time if anything changed. True if it did.
    fn apply<'a>(&mut self, gates: impl Iterator<Item = (&'a Hash128, &'a bool)>, time: f64) -> bool {
        let mut changed = false;
        for (&id, &open) in gates {
            let Some(i) = self.index_of(id) else { continue };
            if i >= self.closed.len() || self.closed[i] == !open {
                continue;
            }
            self.closed[i] = !open;
            changed = true;
        }
        if changed {
            self.last_change = time;
        }
        changed
    }
}

/// The world's gates and the loaded chunks' tables.
#[derive(Clone, Debug, Default)]
pub struct GateTables {
    tables: BTreeMap<Hash128, GateTable>,
    /// Every gate the host has set (`NavGate` components): id -> open.
    gates: BTreeMap<Hash128, bool>,
    /// Gates set since the last apply.
    changed: BTreeMap<Hash128, bool>,
}

impl GateTables {
    /// A chunk loaded (or was rebaked): its table, not yet synced.
    pub fn load(&mut self, chunk: Hash128, file: &BakeFile) {
        self.tables.insert(chunk, GateTable::from_file(file));
    }

    pub fn unload(&mut self, chunk: Hash128) {
        self.tables.remove(&chunk);
    }

    /// `NavGate.Open` set: applied on the next [`GateTables::apply`].
    pub fn set(&mut self, id: Hash128, open: bool) {
        self.gates.insert(id, open);
        self.changed.insert(id, open);
    }

    /// The host's state of a gate, if it has set one.
    pub fn gate(&self, id: Hash128) -> Option<bool> {
        self.gates.get(&id).copied()
    }

    /// `NavGateSystem.OnUpdate`: new tables take every gate's state, then changed gates go into every table. True if
    /// any table's states changed.
    pub fn apply(&mut self, time: f64) -> bool {
        let mut any = false;
        for t in self.tables.values_mut() {
            if !t.synced {
                any |= t.apply(self.gates.iter(), time);
                t.synced = true;
            }
        }
        if !self.changed.is_empty() {
            let changed = std::mem::take(&mut self.changed);
            for t in self.tables.values_mut() {
                any |= t.apply(changed.iter(), time);
            }
        }
        any
    }

    /// A chunk's current gate states, for `NavChunks::gather`.
    pub fn state(&self, chunk: Hash128) -> Option<GateState> {
        self.tables.get(&chunk).map(|t| GateState { closed: t.closed.clone(), last_change: t.last_change })
    }

    pub fn table(&self, chunk: Hash128) -> Option<&GateTable> {
        self.tables.get(&chunk)
    }
}
