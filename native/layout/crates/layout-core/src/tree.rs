//! The node store Taffy lays out (ADR 0433 follow-up): a vector of nodes indexed by handle, with parent links for dirty
//! propagation, implementing Taffy's low-level tree traits. It mirrors `TaffyTree`'s own view (`taffy_tree.rs`: dispatch
//! by display, hidden subtrees, out-of-flow boxes, block formatting contexts) and adds what `TaffyTree` can't: `calc()`
//! lengths. Each mixed length (`calc(50% + -12px)`) is a `CalcValue` the node owns, boxed so its address is stable; the
//! style holds a `CalcHandle` pointing at it, and `resolve_calc_value` returns `px + fraction * basis`.
//! Checked against Taffy 0.16.0; re-read `taffy_tree.rs`'s `TaffyView` when upgrading Taffy.

use taffy::prelude::*;
use taffy::tree::{LayoutInput, LayoutOutput, RunMode};
use taffy::util::ResolveOrZero;
use taffy::{
    compute_block_layout, compute_cached_layout, compute_flexbox_layout, compute_grid_layout, compute_hidden_layout, compute_leaf_layout,
    compute_oof_layout, compute_root_layout, Baselines, BlockContext, Cache, CacheTree, CalcHandle, ClearState, LayoutBlockContainer,
    LayoutContainingBlock, LayoutFlexboxContainer, LayoutGridContainer, LayoutPartialTree, TraversePartialTree, TraverseTree,
};

use crate::{MeasureInput, Measured};

/// A linear `calc()` length: pixels plus a fraction (0–1) of the percentage basis. 8-aligned, as a `CalcHandle`'s
/// pointer must be (its low three bits carry a tag).
#[repr(C, align(8))]
pub(crate) struct CalcValue {
    px: f32,
    fraction: f32,
}

impl CalcValue {
    /// A boxed value and the handle that points at it (valid while the box lives).
    pub(crate) fn boxed(px: f32, fraction: f32) -> (Box<CalcValue>, CalcHandle) {
        let b = Box::new(CalcValue { px, fraction });
        let handle = CalcHandle::from_ptr(&*b as *const CalcValue as *const ());
        (b, handle)
    }
}

/// Resolves a handle made by `CalcValue::boxed`. Every handle in a node's style points at a box that node owns (a
/// property's box is replaced in the same call as its style value, and both go when the node does).
fn resolve_calc(handle: CalcHandle, basis: f32) -> f32 {
    // SAFETY: as above: handles only come from `CalcValue::boxed`, and the box outlives every style value holding it.
    let v = unsafe { &*(handle.ptr() as *const CalcValue) };
    v.px + v.fraction * basis
}

/// How many length properties may hold a `calc()` (`prop_length` codes are 0..CALC_SLOTS).
pub(crate) const CALC_SLOTS: usize = 25;

pub(crate) struct Node {
    pub(crate) style: Style,
    pub(crate) measured: bool,
    pub(crate) parent: Option<u32>,
    pub(crate) children: Vec<NodeId>,
    pub(crate) cache: Cache,
    pub(crate) layout: Layout,
    pub(crate) hoisted: Vec<NodeId>,
    /// The `calc()` values its style's handles point at, by length property.
    pub(crate) calcs: [Option<Box<CalcValue>>; CALC_SLOTS],
}

impl Node {
    pub(crate) fn new(style: Style, measured: bool) -> Self {
        Node { style, measured, parent: None, children: Vec::new(), cache: Cache::new(), layout: Layout::with_order(0), hoisted: Vec::new(), calcs: Default::default() }
    }
}

/// The nodes, by handle (`None`: a freed handle).
#[derive(Default)]
pub(crate) struct Nodes {
    pub(crate) slots: Vec<Option<Node>>,
}

impl Nodes {
    pub(crate) fn get(&self, h: u32) -> Option<&Node> {
        self.slots.get(h as usize).and_then(|n| n.as_ref())
    }

    pub(crate) fn get_mut(&mut self, h: u32) -> Option<&mut Node> {
        self.slots.get_mut(h as usize).and_then(|n| n.as_mut())
    }

    /// Clears the node's cache and its ancestors' (stopping at one already clear, whose ancestors are too).
    pub(crate) fn mark_dirty(&mut self, mut h: u32) {
        while let Some(n) = self.get_mut(h) {
            if matches!(n.cache.clear(), ClearState::AlreadyEmpty) {
                break;
            }
            match n.parent {
                Some(p) => h = p,
                None => break,
            }
        }
    }

    /// Lays out the tree under `root` in `available` space.
    pub(crate) fn compute(&mut self, root: u32, available: Size<AvailableSpace>, measure: &mut dyn FnMut(u32, MeasureInput) -> Measured) {
        if self.get(root).is_none() {
            return;
        }
        let mut view = View { nodes: self, measure };
        compute_root_layout(&mut view, NodeId::from(root as usize), available);
    }
}

fn key(id: NodeId) -> usize {
    usize::from(id)
}

/// The nodes and the measure callback, for one layout.
struct View<'a> {
    nodes: &'a mut Nodes,
    measure: &'a mut dyn FnMut(u32, MeasureInput) -> Measured,
}

impl View<'_> {
    fn node(&self, id: NodeId) -> &Node {
        self.nodes.slots[key(id)].as_ref().expect("layout reached a freed node")
    }

    fn node_mut(&mut self, id: NodeId) -> &mut Node {
        self.nodes.slots[key(id)].as_mut().expect("layout reached a freed node")
    }

    /// A measured leaf: Taffy's leaf layout around the callback's size, and its first baseline in its border box.
    fn measure_leaf(&mut self, id: NodeId, inputs: LayoutInput) -> LayoutOutput {
        let h = key(id) as u32;
        let View { nodes, measure } = self;
        let style = &nodes.slots[key(id)].as_ref().expect("layout reached a freed node").style;
        let mut baseline: Option<Option<f32>> = None;
        let mut output = compute_leaf_layout(inputs, style, resolve_calc, |known, avail| {
            let m = measure(h, MeasureInput { known_width: known.width, known_height: known.height, available_width: avail.width, available_height: avail.height });
            baseline = Some(m.baseline.filter(|b| b.is_finite()));
            Size { width: known.width.unwrap_or(finite_or_0(m.width)), height: known.height.unwrap_or(finite_or_0(m.height)) }
        });
        let padding = style.padding.resolve_or_zero(inputs.parent_size.width, resolve_calc);
        let border = style.border.resolve_or_zero(inputs.parent_size.width, resolve_calc);
        // With both sizes known the leaf isn't measured; a full layout (which baseline alignment asks for) still needs
        // its baseline, so it's asked at its content size.
        if baseline.is_none() && inputs.run_mode == RunMode::PerformLayout {
            let (w, hh) = (output.size.width, output.size.height);
            let (ew, eh) = (padding.left + padding.right + border.left + border.right, padding.top + padding.bottom + border.top + border.bottom);
            let (cw, ch) = ((w - ew).max(0.0), (hh - eh).max(0.0));
            let m = measure(h, MeasureInput { known_width: Some(cw), known_height: Some(ch), available_width: AvailableSpace::Definite(cw), available_height: AvailableSpace::Definite(ch) });
            baseline = Some(m.baseline.filter(|b| b.is_finite()));
        }
        if let Some(Some(b)) = baseline {
            output.baselines = Baselines::from_first(Some(padding.top + border.top + b));
        }
        output
    }

    /// `TaffyView::compute_child_layout`: the cache, then the algorithm by display, then out-of-flow boxes.
    fn layout_child(&mut self, id: NodeId, inputs: LayoutInput, block_ctx: Option<&mut BlockContext<'_>>) -> LayoutOutput {
        if inputs.run_mode == RunMode::PerformHiddenLayout {
            return compute_hidden_layout(self, id);
        }
        compute_cached_layout(self, id, inputs, |tree, id, inputs| {
            let node = tree.node(id);
            let (display, has_children, measured) = (node.style.display, !node.children.is_empty(), node.measured);
            let mut output = match (display, has_children) {
                (Display::None, _) => compute_hidden_layout(tree, id),
                (Display::Block, true) => compute_block_layout(tree, id, inputs, block_ctx),
                (Display::FlowRoot, true) => compute_block_layout(tree, id, inputs, None),
                (Display::Flex, true) => compute_flexbox_layout(tree, id, inputs),
                (Display::Grid, true) => compute_grid_layout(tree, id, inputs),
                (_, false) if measured => tree.measure_leaf(id, inputs),
                (_, false) => compute_leaf_layout(inputs, &tree.node(id).style, resolve_calc, |_, _| Size::ZERO),
            };
            if inputs.run_mode == RunMode::PerformLayout {
                compute_oof_layout(tree, id, &mut output);
            }
            output
        })
    }
}

fn finite_or_0(v: f32) -> f32 {
    if v.is_finite() { v } else { 0.0 }
}

pub(crate) struct ChildIter<'a>(core::slice::Iter<'a, NodeId>);

impl Iterator for ChildIter<'_> {
    type Item = NodeId;
    fn next(&mut self) -> Option<NodeId> {
        self.0.next().copied()
    }
}

impl TraversePartialTree for View<'_> {
    type ChildIter<'a>
        = ChildIter<'a>
    where
        Self: 'a;

    fn child_ids(&self, id: NodeId) -> Self::ChildIter<'_> {
        ChildIter(self.node(id).children.iter())
    }

    fn child_count(&self, id: NodeId) -> usize {
        self.node(id).children.len()
    }

    fn get_child_id(&self, id: NodeId, index: usize) -> NodeId {
        self.node(id).children[index]
    }
}

impl TraverseTree for View<'_> {}

impl LayoutPartialTree for View<'_> {
    type CoreContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;

    type CustomIdent = String;

    fn get_core_container_style(&self, id: NodeId) -> Self::CoreContainerStyle<'_> {
        &self.node(id).style
    }

    fn resolve_calc_value(&self, val: CalcHandle, basis: f32) -> f32 {
        resolve_calc(val, basis)
    }

    fn set_unrounded_layout(&mut self, id: NodeId, layout: &Layout) {
        self.node_mut(id).layout = *layout;
    }

    fn compute_child_layout(&mut self, id: NodeId, inputs: LayoutInput) -> LayoutOutput {
        self.layout_child(id, inputs, None)
    }
}

impl LayoutContainingBlock for View<'_> {
    type OofItemStyle<'a>
        = &'a Style
    where
        Self: 'a;

    fn get_oof_item_style(&self, id: NodeId) -> Self::OofItemStyle<'_> {
        &self.node(id).style
    }

    fn clear_hoisted_children(&mut self, id: NodeId) {
        self.node_mut(id).hoisted.clear();
    }

    fn add_hoisted_children(&mut self, id: NodeId, hoisted: &[NodeId]) {
        self.node_mut(id).hoisted.extend_from_slice(hoisted);
    }
}

impl CacheTree for View<'_> {
    fn cache_get(&self, id: NodeId, input: &LayoutInput) -> Option<LayoutOutput> {
        self.node(id).cache.get(input)
    }

    fn cache_store(&mut self, id: NodeId, input: &LayoutInput, output: LayoutOutput) {
        self.node_mut(id).cache.store(input, output)
    }

    fn cache_clear(&mut self, id: NodeId) {
        self.node_mut(id).cache.clear();
    }
}

impl LayoutBlockContainer for View<'_> {
    type BlockContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;
    type BlockItemStyle<'a>
        = &'a Style
    where
        Self: 'a;

    fn get_block_container_style(&self, id: NodeId) -> Self::BlockContainerStyle<'_> {
        &self.node(id).style
    }

    fn get_block_child_style(&self, id: NodeId) -> Self::BlockItemStyle<'_> {
        &self.node(id).style
    }

    fn compute_block_child_layout(&mut self, id: NodeId, inputs: LayoutInput, block_ctx: Option<&mut BlockContext<'_>>) -> LayoutOutput {
        self.layout_child(id, inputs, block_ctx)
    }
}

impl LayoutFlexboxContainer for View<'_> {
    type FlexboxContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;
    type FlexboxItemStyle<'a>
        = &'a Style
    where
        Self: 'a;

    fn get_flexbox_container_style(&self, id: NodeId) -> Self::FlexboxContainerStyle<'_> {
        &self.node(id).style
    }

    fn get_flexbox_child_style(&self, id: NodeId) -> Self::FlexboxItemStyle<'_> {
        &self.node(id).style
    }
}

impl LayoutGridContainer for View<'_> {
    type GridContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;
    type GridItemStyle<'a>
        = &'a Style
    where
        Self: 'a;

    fn get_grid_container_style(&self, id: NodeId) -> Self::GridContainerStyle<'_> {
        &self.node(id).style
    }

    fn get_grid_child_style(&self, id: NodeId) -> Self::GridItemStyle<'_> {
        &self.node(id).style
    }
}
