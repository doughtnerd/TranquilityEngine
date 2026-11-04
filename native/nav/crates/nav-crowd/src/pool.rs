//! Search pools (Foxfire's pooled search entities: `NavPathSearch`, `NavFlightSearch`, `NavRouteSearch`,
//! `NavFlightRouteSearch` with `NavSearchActive`, and their `NavSearchNode` / `NavSearchOpen` / `NavSearchKey`
//! buffers).
//!
//! A pool is a fixed number of searches, each with its own [`SearchBufferStore`] whose buffers keep their capacity
//! between searches, so searching allocates nothing once warm and a tick's search cost is bounded by pool size times
//! slice. Requests that find no free search wait (urgent first, then oldest: the assigning step's job).
use crate::components::NavSearch;
use crate::ids::AgentId;
use nav_query::search::SearchBufferStore;

/// One pooled search: its state, its buffers and whether it's in use (`NavSearchActive`).
#[derive(Clone, Debug, Default)]
pub struct PooledSearch<T: NavSearch> {
    pub search: T,
    pub store: SearchBufferStore,
    pub active: bool,
}

/// A pool of searches of one kind.
#[derive(Clone, Debug)]
pub struct SearchPool<T: NavSearch> {
    pub entries: Vec<PooledSearch<T>>,
}

impl<T: NavSearch> Default for SearchPool<T> {
    fn default() -> Self {
        Self { entries: Vec::new() }
    }
}

impl<T: NavSearch> SearchPool<T> {
    /// Grows the pool to `size` searches (never shrinks: searches in use keep running).
    pub fn ensure(&mut self, size: usize) {
        while self.entries.len() < size {
            self.entries.push(PooledSearch { search: T::default(), store: SearchBufferStore::default(), active: false });
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn active_count(&self) -> usize {
        self.entries.iter().filter(|e| e.active).count()
    }

    /// Takes a free search for `agent` (`INavSearch.Assign`); None if every one is busy.
    pub fn assign(&mut self, agent: AgentId) -> Option<usize> {
        let i = self.entries.iter().position(|e| !e.active)?;
        let e = &mut self.entries[i];
        e.search.assign(agent);
        e.active = true;
        Some(i)
    }

    /// Frees a search (its buffers keep their capacity).
    pub fn release(&mut self, i: usize) {
        if let Some(e) = self.entries.get_mut(i) {
            e.active = false;
        }
    }

    /// The search in use for `agent`, if any.
    pub fn find(&self, agent: AgentId) -> Option<usize> {
        self.entries.iter().position(|e| e.active && e.search.agent() == agent)
    }

    /// Frees every search serving an agent `alive` says is gone.
    pub fn release_dead(&mut self, alive: impl Fn(AgentId) -> bool) {
        for e in &mut self.entries {
            if e.active && !alive(e.search.agent()) {
                e.active = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::NavPathSearch;
    use crate::ids::Handle;

    #[test]
    fn assign_reuses_free_searches_and_keeps_buffers() {
        let mut pool: SearchPool<NavPathSearch> = SearchPool::default();
        pool.ensure(2);
        let a = AgentId(Handle::new(0, 1));
        let b = AgentId(Handle::new(1, 1));
        let c = AgentId(Handle::new(2, 1));
        assert_eq!(pool.assign(a), Some(0));
        assert_eq!(pool.assign(b), Some(1));
        assert_eq!(pool.assign(c), None, "all busy");
        pool.entries[0].store.nodes.reserve(64);
        pool.entries[0].search.stamp = 7;
        pool.release(0);
        assert_eq!(pool.assign(c), Some(0));
        assert_eq!(pool.entries[0].search.agent, c);
        assert_eq!(pool.entries[0].search.stamp, 7, "the stamp outlives the search");
        assert!(pool.entries[0].store.nodes.capacity() >= 64);
        pool.release_dead(|id| id != b);
        assert_eq!(pool.find(b), None);
        assert_eq!(pool.active_count(), 1);
    }
}
