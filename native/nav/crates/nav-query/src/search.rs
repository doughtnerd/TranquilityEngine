//! A search's nodes, open set and key table (Foxfire's `NavSearchStore.cs`), shared by the sliced
//! searches: walking A* (`pathfinding`), flight A* (`volume`), and later the route searches. A search
//! runs a few steps per frame, so its state lives in a store between steps.
//!
//! [`SearchBufferStore`] keeps its key table across searches and marks its own slots with a stamp, so
//! a new search reuses the table without clearing it (Foxfire's search-entity buffers);
//! [`SearchListStore`] is for a search run to the end in one call.
use nav_math::Float3;
use std::collections::HashMap;

/// How a route search reached a node (`NavRouteVia`).
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NavRouteVia {
    #[default]
    Start = 0,
    NavLink,
    Cross,
    Neighbor,
    AirCross,
    Takeoff,
    Landing,
    Edge,
    /// `via_index`: the route graphs' overlay landings.
    OverlayTakeoff,
    OverlayLanding,
}

/// One node of a search (`NavSearchNode`). A route search: a polygon of a graph (ground), a leaf of a
/// volume with its label slot, or the frontier node. A flight search: a leaf (`item`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SearchNode {
    /// Routes: graph (ground), volume (air), or the frontier node's space.
    pub space: i32,
    /// Polygon (ground) or leaf (air).
    pub item: i32,
    pub parent: i32,
    /// A graph link (Cross), air link (AirCross) or landing link (Takeoff / Landing).
    pub via_index: i32,
    pub g: f32,
    pub f: f32,
    pub dist: f32,
    /// Distance flown since the last take-off (or flown so far).
    pub air: f32,
    /// Where the route enters this polygon or leaf.
    pub pos: Float3,
    pub via: NavRouteVia,
    /// The leaf's label slot.
    pub slot: u8,
    /// [`SearchNode::GROUND_FLAG`], [`SearchNode::CLOSED_FLAG`].
    pub flags: u8,
}

impl SearchNode {
    pub const GROUND_FLAG: u8 = 1;
    pub const CLOSED_FLAG: u8 = 2;

    #[inline]
    pub fn ground(&self) -> bool {
        self.flags & Self::GROUND_FLAG != 0
    }
    #[inline]
    pub fn closed(&self) -> bool {
        self.flags & Self::CLOSED_FLAG != 0
    }
    #[inline]
    pub fn set_closed(&mut self, value: bool) {
        self.flags = if value { self.flags | Self::CLOSED_FLAG } else { self.flags & !Self::CLOSED_FLAG };
    }
}

/// An open-set entry: a binary heap on `f` (`NavSearchOpen`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SearchOpen {
    pub f: f32,
    pub node: i32,
}

/// A slot of a key table (`NavSearchKey`; open addressing, power-of-two size). In use only if its
/// stamp is the current search's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SearchKey {
    pub key: i64,
    pub node: i32,
    pub stamp: u32,
}

/// Where a search keeps its nodes, open set and key table (`INavSearchStore`).
pub trait SearchStore {
    fn node_count(&self) -> usize;
    fn open_count(&self) -> usize;
    /// A new search: nodes and open set emptied.
    fn clear(&mut self);
    fn get_node(&self, index: i32) -> SearchNode;
    fn set_node(&mut self, index: i32, node: SearchNode);
    /// Adds the node and its key; returns its index.
    fn add_node(&mut self, key: i64, node: SearchNode) -> i32;
    fn try_get_node(&self, key: i64) -> Option<i32>;
    fn push(&mut self, item: SearchOpen);
    /// The open entry with the smallest `f`. The open set must not be empty.
    fn pop(&mut self) -> SearchOpen;
}

/// A store whose key table outlives each search (`NavSearchBufferStore`): a sliced search that runs
/// over several frames, from a pool of searches.
#[derive(Clone, Debug)]
pub struct SearchBufferStore {
    pub nodes: Vec<SearchNode>,
    pub open: Vec<SearchOpen>,
    pub keys: Vec<SearchKey>,
    /// Never 0 (a fresh slot's stamp). [`SearchBufferStore::begin`] moves to the next.
    pub stamp: u32,
}

impl Default for SearchBufferStore {
    fn default() -> Self {
        Self { nodes: Vec::new(), open: Vec::new(), keys: Vec::new(), stamp: 1 }
    }
}

impl SearchBufferStore {
    /// Starts a new search: a new stamp (so the old key slots read as free) and empty nodes and open set.
    pub fn begin(&mut self) {
        self.stamp = self.stamp.wrapping_add(1);
        if self.stamp == 0 {
            // Wrapped: stale slots could carry any stamp, so wipe them once.
            for k in &mut self.keys {
                *k = SearchKey::default();
            }
            self.stamp = 1;
        }
        self.clear();
    }

    /// Twice the slots (at least 256), the search's keys moved over, every other slot fresh.
    fn grow(&mut self) {
        let size = (self.keys.len() * 2).max(256);
        let old = std::mem::replace(&mut self.keys, vec![SearchKey::default(); size]);
        for k in old.iter().filter(|k| k.stamp == self.stamp) {
            Self::insert(&mut self.keys, k.key, k.node, self.stamp);
        }
    }

    fn insert(keys: &mut [SearchKey], key: i64, node: i32, stamp: u32) {
        let mask = keys.len() - 1;
        let mut i = slot(key, mask);
        while keys[i].stamp == stamp {
            i = (i + 1) & mask;
        }
        keys[i] = SearchKey { key, node, stamp };
    }
}

/// The key's first slot. Foxfire uses Unity's `math.hash(int2)`; any well-mixed hash gives the same
/// lookups (only probe lengths differ), so this is a plain 64-bit mix.
#[inline]
fn slot(key: i64, mask: usize) -> usize {
    let mut x = key as u64;
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
    x ^= x >> 33;
    (x as usize) & mask
}

impl SearchStore for SearchBufferStore {
    fn node_count(&self) -> usize {
        self.nodes.len()
    }
    fn open_count(&self) -> usize {
        self.open.len()
    }
    /// Nodes and open set emptied; the key table is left as it is (call [`SearchBufferStore::begin`]
    /// for a new search, which also moves the stamp).
    fn clear(&mut self) {
        self.nodes.clear();
        self.open.clear();
    }
    fn get_node(&self, index: i32) -> SearchNode {
        self.nodes[index as usize]
    }
    fn set_node(&mut self, index: i32, node: SearchNode) {
        self.nodes[index as usize] = node;
    }
    fn add_node(&mut self, key: i64, node: SearchNode) -> i32 {
        if (self.nodes.len() + 1) * 2 > self.keys.len() {
            self.grow();
        }
        let index = self.nodes.len() as i32;
        self.nodes.push(node);
        Self::insert(&mut self.keys, key, index, self.stamp);
        index
    }
    fn try_get_node(&self, key: i64) -> Option<i32> {
        if self.keys.is_empty() {
            return None;
        }
        let mask = self.keys.len() - 1;
        let mut i = slot(key, mask);
        loop {
            let s = self.keys[i];
            if s.stamp != self.stamp {
                return None;
            }
            if s.key == key {
                return Some(s.node);
            }
            i = (i + 1) & mask;
        }
    }
    fn push(&mut self, item: SearchOpen) {
        self.open.push(item);
        let last = self.open.len() - 1;
        sift_up(&mut self.open, last);
    }
    fn pop(&mut self) -> SearchOpen {
        pop_heap(&mut self.open)
    }
}

/// A store for a search run whole in one call (`NavSearchListStore`).
#[derive(Clone, Debug, Default)]
pub struct SearchListStore {
    pub nodes: Vec<SearchNode>,
    pub open: Vec<SearchOpen>,
    pub keys: HashMap<i64, i32>,
}

impl SearchStore for SearchListStore {
    fn node_count(&self) -> usize {
        self.nodes.len()
    }
    fn open_count(&self) -> usize {
        self.open.len()
    }
    fn clear(&mut self) {
        self.nodes.clear();
        self.open.clear();
        self.keys.clear();
    }
    fn get_node(&self, index: i32) -> SearchNode {
        self.nodes[index as usize]
    }
    fn set_node(&mut self, index: i32, node: SearchNode) {
        self.nodes[index as usize] = node;
    }
    fn add_node(&mut self, key: i64, node: SearchNode) -> i32 {
        let index = self.nodes.len() as i32;
        self.nodes.push(node);
        self.keys.insert(key, index);
        index
    }
    fn try_get_node(&self, key: i64) -> Option<i32> {
        self.keys.get(&key).copied()
    }
    fn push(&mut self, item: SearchOpen) {
        self.open.push(item);
        let last = self.open.len() - 1;
        sift_up(&mut self.open, last);
    }
    fn pop(&mut self) -> SearchOpen {
        pop_heap(&mut self.open)
    }
}

fn pop_heap(heap: &mut Vec<SearchOpen>) -> SearchOpen {
    let top = heap[0];
    let last = heap.len() - 1;
    heap[0] = heap[last];
    heap.truncate(last);
    sift_down(heap, 0);
    top
}

/// `NavSearchHeap.SiftUp`.
pub fn sift_up(heap: &mut [SearchOpen], mut i: usize) {
    while i > 0 {
        let parent = (i - 1) >> 1;
        if heap[parent].f <= heap[i].f {
            break;
        }
        heap.swap(parent, i);
        i = parent;
    }
}

/// `NavSearchHeap.SiftDown`.
pub fn sift_down(heap: &mut [SearchOpen], mut i: usize) {
    loop {
        let l = 2 * i + 1;
        let r = l + 1;
        let mut smallest = i;
        if l < heap.len() && heap[l].f < heap[smallest].f {
            smallest = l;
        }
        if r < heap.len() && heap[r].f < heap[smallest].f {
            smallest = r;
        }
        if smallest == i {
            break;
        }
        heap.swap(smallest, i);
        i = smallest;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exercise(store: &mut impl SearchStore) {
        store.clear();
        for k in 0..1000i64 {
            let n = store.add_node(k * 7919 - 500, SearchNode { item: k as i32, ..SearchNode::default() });
            assert_eq!(n, k as i32);
        }
        for k in (0..1000i64).rev() {
            assert_eq!(store.try_get_node(k * 7919 - 500), Some(k as i32));
        }
        assert_eq!(store.try_get_node(3), None);
        for (i, f) in [5.0, 1.0, 4.0, 1.0, 3.0, 9.0, 0.5].into_iter().enumerate() {
            store.push(SearchOpen { f, node: i as i32 });
        }
        let order: Vec<f32> = (0..7).map(|_| store.pop().f).collect();
        assert_eq!(order, vec![0.5, 1.0, 1.0, 3.0, 4.0, 5.0, 9.0]);
    }

    #[test]
    fn both_stores_add_find_and_order_the_open_set() {
        exercise(&mut SearchBufferStore::default());
        exercise(&mut SearchListStore::default());
    }

    #[test]
    fn a_new_search_reuses_the_key_table_without_seeing_old_keys() {
        let mut s = SearchBufferStore::default();
        s.begin();
        s.add_node(42, SearchNode::default());
        let slots = s.keys.len();
        s.begin();
        assert_eq!(s.try_get_node(42), None, "a key from the previous search");
        assert_eq!(s.keys.len(), slots, "the table was kept");
        s.add_node(42, SearchNode { item: 9, ..SearchNode::default() });
        assert_eq!(s.get_node(s.try_get_node(42).unwrap()).item, 9);
    }

    #[test]
    fn closed_flag() {
        let mut n = SearchNode { flags: SearchNode::GROUND_FLAG, ..SearchNode::default() };
        n.set_closed(true);
        assert!(n.closed() && n.ground());
        n.set_closed(false);
        assert!(!n.closed() && n.ground());
    }
}
