//! Myco's UI layout tree (ADR 0433): Taffy's `TaffyTree` behind small numeric handles and three style
//! setters (enums, lengths, numbers), so the WebAssembly boundary passes only numbers. A measured leaf
//! (text, a replaced element) asks a callback for its size; everything else is laid out by Taffy's CSS
//! flexbox, grid and block algorithms. Rounding is off: boxes are exact in UI pixels.
//!
//! The property and value codes below are mirrored by `src/engine/ui/taffy/layoutTree.ts`; change both
//! together.

use taffy::prelude::*;
/// What a measured leaf is told about the room on an axis.
pub use taffy::style::AvailableSpace;
use taffy::style::{AlignContent, AlignItems, BoxSizing, Direction, Overflow};
use taffy::tree::{LayoutInput, RunMode};
use taffy::util::ResolveOrZero;
use taffy::{compute_leaf_layout, Baselines, LayoutOutput};

/// Enum properties (`set_enum`).
pub mod prop_enum {
    /// 0 flex, 1 none, 2 block, 3 grid.
    pub const DISPLAY: u8 = 0;
    /// 0 row, 1 column, 2 row-reverse, 3 column-reverse.
    pub const FLEX_DIRECTION: u8 = 1;
    /// A content value (`content`).
    pub const JUSTIFY_CONTENT: u8 = 2;
    /// An items value (`items`).
    pub const ALIGN_ITEMS: u8 = 3;
    /// An items value, or `AUTO` (follow the parent's align-items).
    pub const ALIGN_SELF: u8 = 4;
    /// A content value.
    pub const ALIGN_CONTENT: u8 = 5;
    /// 0 nowrap, 1 wrap, 2 wrap-reverse.
    pub const FLEX_WRAP: u8 = 6;
    /// 0 relative, 1 absolute, 2 static.
    pub const POSITION: u8 = 7;
    /// 0 visible, 1 clip, 2 hidden, 3 scroll.
    pub const OVERFLOW_X: u8 = 8;
    /// As `OVERFLOW_X`.
    pub const OVERFLOW_Y: u8 = 9;
    /// 0 ltr, 1 rtl.
    pub const DIRECTION: u8 = 10;
    /// 0 border-box, 1 content-box.
    pub const BOX_SIZING: u8 = 11;
    /// An items value, or `AUTO` (grid items only).
    pub const JUSTIFY_SELF: u8 = 12;
    /// An items value (grid containers only).
    pub const JUSTIFY_ITEMS: u8 = 13;
}

/// Values of `ALIGN_ITEMS`, `ALIGN_SELF`, `JUSTIFY_SELF` and `JUSTIFY_ITEMS`.
pub mod items {
    pub const FLEX_START: u8 = 0;
    pub const CENTER: u8 = 1;
    pub const FLEX_END: u8 = 2;
    pub const STRETCH: u8 = 3;
    pub const BASELINE: u8 = 4;
    pub const START: u8 = 5;
    pub const END: u8 = 6;
    pub const NORMAL: u8 = 7;
    /// `ALIGN_SELF` / `JUSTIFY_SELF` only.
    pub const AUTO: u8 = 255;
}

/// Values of `JUSTIFY_CONTENT` and `ALIGN_CONTENT`.
pub mod content {
    pub const FLEX_START: u8 = 0;
    pub const CENTER: u8 = 1;
    pub const FLEX_END: u8 = 2;
    pub const SPACE_BETWEEN: u8 = 3;
    pub const SPACE_AROUND: u8 = 4;
    pub const SPACE_EVENLY: u8 = 5;
    pub const STRETCH: u8 = 6;
    pub const START: u8 = 7;
    pub const END: u8 = 8;
    pub const NORMAL: u8 = 9;
}

/// Length properties (`set_length`).
pub mod prop_length {
    pub const WIDTH: u8 = 0;
    pub const HEIGHT: u8 = 1;
    pub const MIN_WIDTH: u8 = 2;
    pub const MIN_HEIGHT: u8 = 3;
    pub const MAX_WIDTH: u8 = 4;
    pub const MAX_HEIGHT: u8 = 5;
    pub const FLEX_BASIS: u8 = 6;
    /// Then right, bottom, left (+1, +2, +3).
    pub const MARGIN_TOP: u8 = 7;
    /// Then right, bottom, left.
    pub const PADDING_TOP: u8 = 11;
    /// Then right, bottom, left.
    pub const BORDER_TOP: u8 = 15;
    /// Then right, bottom, left.
    pub const INSET_TOP: u8 = 19;
    pub const COLUMN_GAP: u8 = 23;
    pub const ROW_GAP: u8 = 24;
}

/// Length kinds (`set_length`). `AUTO` on padding, border and gap (which have no auto) sets 0.
pub mod kind {
    /// `auto` for sizes, margins and insets; `none` for max sizes; `auto` (content-based) for min sizes.
    pub const AUTO: u8 = 0;
    pub const PX: u8 = 1;
    pub const PERCENT: u8 = 2;
}

/// Number properties (`set_number`).
pub mod prop_number {
    pub const FLEX_GROW: u8 = 0;
    pub const FLEX_SHRINK: u8 = 1;
    /// Width over height; a non-finite or non-positive value unsets it.
    pub const ASPECT_RATIO: u8 = 2;
    /// The space `overflow: scroll` reserves for a scrollbar.
    pub const SCROLLBAR_WIDTH: u8 = 3;
}

/// The floats `layout` writes, in order.
pub mod out {
    /// x, y (relative to the parent's border box), width, height (the border box).
    pub const X: usize = 0;
    /// Border top, right, bottom, left.
    pub const BORDER: usize = 4;
    /// Padding top, right, bottom, left.
    pub const PADDING: usize = 8;
    /// Margin top, right, bottom, left (resolved, auto margins included).
    pub const MARGIN: usize = 12;
    /// The scrollable overflow rectangle (left, top, right, bottom) relative to the border box.
    pub const OVERFLOW: usize = 16;
    /// Scrollbar width, height (space reserved by `overflow: scroll`).
    pub const SCROLLBAR: usize = 20;
    /// How many floats `layout` writes.
    pub const LEN: usize = 22;
}

/// What a measured leaf is asked: the sizes already known (`None` when not) and the space available on each axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeasureInput {
    pub known_width: Option<f32>,
    pub known_height: Option<f32>,
    pub available_width: AvailableSpace,
    pub available_height: AvailableSpace,
}

/// A measured leaf's answer: its content size and, when it has one (text), its first baseline down from the top of
/// its content box. Layout puts the baseline in the node's border box (adding its padding and border), and flexbox's
/// `align-items: baseline` and container baselines use it, as CSS's first baseline.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Measured {
    pub width: f32,
    pub height: f32,
    pub baseline: Option<f32>,
}

impl Measured {
    /// A size with no baseline.
    pub fn size(width: f32, height: f32) -> Self {
        Self { width, height, baseline: None }
    }
}

/// A layout tree whose nodes are named by `u32` handles (reused after `remove`).
pub struct UiLayout {
    tree: TaffyTree<u32>,
    nodes: Vec<Option<NodeId>>,
    free: Vec<u32>,
}

impl Default for UiLayout {
    fn default() -> Self {
        Self::new()
    }
}

fn items_value(v: u8) -> Option<AlignItems> {
    Some(match v {
        items::FLEX_START => AlignItems::FLEX_START,
        items::CENTER => AlignItems::CENTER,
        items::FLEX_END => AlignItems::FLEX_END,
        items::STRETCH => AlignItems::STRETCH,
        items::BASELINE => AlignItems::BASELINE,
        items::START => AlignItems::START,
        items::END => AlignItems::END,
        items::NORMAL => AlignItems::NORMAL,
        _ => return None,
    })
}

fn content_value(v: u8) -> AlignContent {
    match v {
        content::CENTER => AlignContent::CENTER,
        content::FLEX_END => AlignContent::FLEX_END,
        content::SPACE_BETWEEN => AlignContent::SPACE_BETWEEN,
        content::SPACE_AROUND => AlignContent::SPACE_AROUND,
        content::SPACE_EVENLY => AlignContent::SPACE_EVENLY,
        content::STRETCH => AlignContent::STRETCH,
        content::START => AlignContent::START,
        content::END => AlignContent::END,
        content::NORMAL => AlignContent::NORMAL,
        _ => AlignContent::FLEX_START,
    }
}

fn overflow_value(v: u8) -> Overflow {
    match v {
        1 => Overflow::Clip,
        2 => Overflow::Hidden,
        3 => Overflow::Scroll,
        _ => Overflow::Visible,
    }
}

fn finite_or_0(v: f32) -> f32 {
    if v.is_finite() { v } else { 0.0 }
}

fn lpa(k: u8, v: f32) -> LengthPercentageAuto {
    match k {
        kind::PX if v.is_finite() => LengthPercentageAuto::length(v),
        kind::PERCENT if v.is_finite() => LengthPercentageAuto::percent(v / 100.0),
        _ => LengthPercentageAuto::auto(),
    }
}

fn lp(k: u8, v: f32) -> LengthPercentage {
    match k {
        kind::PERCENT if v.is_finite() => LengthPercentage::percent(v / 100.0),
        _ => LengthPercentage::length(if k == kind::PX { finite_or_0(v) } else { 0.0 }),
    }
}

fn dim(k: u8, v: f32) -> Dimension {
    match k {
        kind::PX if v.is_finite() => Dimension::length(v),
        kind::PERCENT if v.is_finite() => Dimension::percent(v / 100.0),
        _ => Dimension::auto(),
    }
}

fn side(r: &mut Rect<LengthPercentageAuto>, i: u8) -> &mut LengthPercentageAuto {
    match i {
        0 => &mut r.top,
        1 => &mut r.right,
        2 => &mut r.bottom,
        _ => &mut r.left,
    }
}

fn side_lp(r: &mut Rect<LengthPercentage>, i: u8) -> &mut LengthPercentage {
    match i {
        0 => &mut r.top,
        1 => &mut r.right,
        2 => &mut r.bottom,
        _ => &mut r.left,
    }
}

/// The browser's initial values where they differ from Taffy's defaults: `position: relative` (every UI
/// element is a containing block, as under Yoga, ADR 0076), `flex-shrink: 1`, `align-items` / `align-content`
/// `normal` (stretch), `display: flex` (the UI core's elements are flex containers).
fn initial_style() -> Style {
    Style { position: Position::Relative, display: Display::Flex, ..Style::default() }
}

impl UiLayout {
    /// An empty tree, rounding off.
    pub fn new() -> Self {
        let mut tree = TaffyTree::new();
        tree.disable_rounding();
        Self { tree, nodes: Vec::new(), free: Vec::new() }
    }

    fn id(&self, h: u32) -> Option<NodeId> {
        self.nodes.get(h as usize).copied().flatten()
    }

    /// A new node with the initial style; `measured` leaves ask the measure callback for their size.
    pub fn create(&mut self, measured: bool) -> u32 {
        let h = self.free.pop().unwrap_or(self.nodes.len() as u32);
        let style = initial_style();
        let id = if measured { self.tree.new_leaf_with_context(style, h) } else { self.tree.new_leaf(style) };
        let id = match id {
            Ok(id) => id,
            Err(_) => return u32::MAX,
        };
        if h as usize == self.nodes.len() {
            self.nodes.push(Some(id));
        } else {
            self.nodes[h as usize] = Some(id);
        }
        h
    }

    /// Removes a node (detaching it from its parent and its children from it); its handle may be reused.
    pub fn remove(&mut self, h: u32) {
        if let Some(id) = self.id(h) {
            let _ = self.tree.remove(id);
            self.nodes[h as usize] = None;
            self.free.push(h);
        }
    }

    /// The node's children, in order (each detached from any earlier parent). Unknown handles are skipped.
    pub fn set_children(&mut self, h: u32, children: &[u32]) {
        let Some(id) = self.id(h) else { return };
        let ids: Vec<NodeId> = children.iter().filter_map(|&c| self.id(c)).collect();
        for &c in &ids {
            if let Some(p) = self.tree.parent(c) {
                if p != id {
                    let _ = self.tree.remove_child(p, c);
                }
            }
        }
        let _ = self.tree.set_children(id, &ids);
    }

    /// How many children the node has.
    pub fn child_count(&self, h: u32) -> usize {
        self.id(h).map(|id| self.tree.child_count(id)).unwrap_or(0)
    }

    fn edit(&mut self, h: u32, f: impl FnOnce(&mut Style)) -> bool {
        let Some(id) = self.id(h) else { return false };
        let Ok(style) = self.tree.style(id) else { return false };
        let mut style = style.clone();
        f(&mut style);
        self.tree.set_style(id, style).is_ok()
    }

    /// Sets an enum property (`prop_enum`) to a value code; false for an unknown handle.
    pub fn set_enum(&mut self, h: u32, prop: u8, v: u8) -> bool {
        self.edit(h, |s| match prop {
            prop_enum::DISPLAY => {
                s.display = match v {
                    1 => Display::None,
                    2 => Display::Block,
                    3 => Display::Grid,
                    _ => Display::Flex,
                }
            }
            prop_enum::FLEX_DIRECTION => {
                s.flex_direction = match v {
                    1 => FlexDirection::Column,
                    2 => FlexDirection::RowReverse,
                    3 => FlexDirection::ColumnReverse,
                    _ => FlexDirection::Row,
                }
            }
            prop_enum::JUSTIFY_CONTENT => s.justify_content = content_value(v),
            prop_enum::ALIGN_ITEMS => s.align_items = items_value(v).unwrap_or(AlignItems::NORMAL),
            prop_enum::ALIGN_SELF => s.align_self = items_value(v),
            prop_enum::ALIGN_CONTENT => s.align_content = content_value(v),
            prop_enum::FLEX_WRAP => {
                s.flex_wrap = match v {
                    1 => FlexWrap::Wrap,
                    2 => FlexWrap::WrapReverse,
                    _ => FlexWrap::NoWrap,
                }
            }
            prop_enum::POSITION => {
                s.position = match v {
                    1 => Position::Absolute,
                    2 => Position::Static,
                    _ => Position::Relative,
                }
            }
            prop_enum::OVERFLOW_X => s.overflow.x = overflow_value(v),
            prop_enum::OVERFLOW_Y => s.overflow.y = overflow_value(v),
            prop_enum::DIRECTION => s.direction = if v == 1 { Direction::Rtl } else { Direction::Ltr },
            prop_enum::BOX_SIZING => s.box_sizing = if v == 1 { BoxSizing::ContentBox } else { BoxSizing::BorderBox },
            prop_enum::JUSTIFY_SELF => s.justify_self = items_value(v),
            prop_enum::JUSTIFY_ITEMS => s.justify_items = items_value(v).unwrap_or(AlignItems::NORMAL),
            _ => {}
        })
    }

    /// Sets a length property (`prop_length`): `kind::AUTO`, a pixel value, or a percentage (0–100).
    pub fn set_length(&mut self, h: u32, prop: u8, k: u8, v: f32) -> bool {
        self.edit(h, |s| match prop {
            prop_length::WIDTH => s.size.width = dim(k, v),
            prop_length::HEIGHT => s.size.height = dim(k, v),
            prop_length::MIN_WIDTH => s.min_size.width = lpa(k, v),
            prop_length::MIN_HEIGHT => s.min_size.height = lpa(k, v),
            prop_length::MAX_WIDTH => s.max_size.width = lpa(k, v),
            prop_length::MAX_HEIGHT => s.max_size.height = lpa(k, v),
            prop_length::FLEX_BASIS => s.flex_basis = dim(k, v),
            p @ prop_length::MARGIN_TOP..=10 => *side(&mut s.margin, p - prop_length::MARGIN_TOP) = lpa(k, v),
            p @ prop_length::PADDING_TOP..=14 => *side_lp(&mut s.padding, p - prop_length::PADDING_TOP) = lp(k, v),
            p @ prop_length::BORDER_TOP..=18 => *side_lp(&mut s.border, p - prop_length::BORDER_TOP) = lp(k, v),
            p @ prop_length::INSET_TOP..=22 => *side(&mut s.inset, p - prop_length::INSET_TOP) = lpa(k, v),
            prop_length::COLUMN_GAP => s.gap.width = lp(k, v),
            prop_length::ROW_GAP => s.gap.height = lp(k, v),
            _ => {}
        })
    }

    /// Sets a number property (`prop_number`).
    pub fn set_number(&mut self, h: u32, prop: u8, v: f32) -> bool {
        self.edit(h, |s| match prop {
            prop_number::FLEX_GROW => s.flex_grow = finite_or_0(v).max(0.0),
            prop_number::FLEX_SHRINK => s.flex_shrink = finite_or_0(v).max(0.0),
            prop_number::ASPECT_RATIO => s.aspect_ratio = (v.is_finite() && v > 0.0).then_some(v),
            prop_number::SCROLLBAR_WIDTH => s.scrollbar_width = finite_or_0(v).max(0.0),
            _ => {}
        })
    }

    /// Marks a measured leaf's content as changed, so it is measured again at the next `compute`.
    pub fn mark_dirty(&mut self, h: u32) {
        if let Some(id) = self.id(h) {
            let _ = self.tree.mark_dirty(id);
        }
    }

    /// Lays out the tree under `root` in the given space (a finite size is definite; `+inf` or NaN is
    /// max-content, `-inf` min-content). Measured leaves get their size (and first baseline) from `measure(handle, input)`.
    pub fn compute(&mut self, root: u32, width: f32, height: f32, mut measure: impl FnMut(u32, MeasureInput) -> Measured) {
        let Some(id) = self.id(root) else { return };
        let space = |v: f32| {
            if v.is_finite() {
                AvailableSpace::Definite(v)
            } else if v == f32::NEG_INFINITY {
                AvailableSpace::MinContent
            } else {
                AvailableSpace::MaxContent
            }
        };
        let available = Size { width: space(width), height: space(height) };
        let _ = self.tree.compute_layout_with_measure(id, available, |inputs: LayoutInput, _node, ctx: Option<&mut u32>, style: &Style| -> LayoutOutput {
            match ctx {
                Some(h) => {
                    let h = *h;
                    let mut baseline: Option<Option<f32>> = None;
                    let mut output = compute_leaf_layout(inputs, style, |_, _| 0.0, |known, avail| {
                        let m = measure(h, MeasureInput { known_width: known.width, known_height: known.height, available_width: avail.width, available_height: avail.height });
                        baseline = Some(m.baseline.filter(|b| b.is_finite()));
                        Size { width: known.width.unwrap_or(finite_or_0(m.width)), height: known.height.unwrap_or(finite_or_0(m.height)) }
                    });
                    let padding = style.padding.resolve_or_zero(inputs.parent_size.width, |_, _| 0.0);
                    let border = style.border.resolve_or_zero(inputs.parent_size.width, |_, _| 0.0);
                    // With both sizes known the leaf isn't measured; a full layout (which baseline alignment asks for)
                    // still needs its baseline, so it's asked at its content size.
                    if baseline.is_none() && inputs.run_mode == RunMode::PerformLayout {
                        let inner = |v: f32, edges: f32| AvailableSpace::Definite((v - edges).max(0.0));
                        let (w, hh) = (output.size.width, output.size.height);
                        let (ew, eh) = (padding.left + padding.right + border.left + border.right, padding.top + padding.bottom + border.top + border.bottom);
                        let m = measure(h, MeasureInput { known_width: Some((w - ew).max(0.0)), known_height: Some((hh - eh).max(0.0)), available_width: inner(w, ew), available_height: inner(hh, eh) });
                        baseline = Some(m.baseline.filter(|b| b.is_finite()));
                    }
                    if let Some(Some(b)) = baseline {
                        output.baselines = Baselines::from_first(Some(padding.top + border.top + b));
                    }
                    output
                }
                None => compute_leaf_layout(inputs, style, |_, _| 0.0, |_, _| Size::ZERO),
            }
        });
    }

    /// Writes the node's computed box (`out::LEN` floats, laid out as `out` says) into `dst`; zeros for an
    /// unknown handle. Returns false when `dst` is too short or the handle is unknown.
    pub fn layout(&self, h: u32, dst: &mut [f32]) -> bool {
        if dst.len() < out::LEN {
            return false;
        }
        let Some(id) = self.id(h) else {
            dst[..out::LEN].fill(0.0);
            return false;
        };
        let l = self.tree.unrounded_layout(id);
        let o = l.scrollable_overflow_rect.rect();
        let v = [
            l.location.x, l.location.y, l.size.width, l.size.height,
            l.border.top, l.border.right, l.border.bottom, l.border.left,
            l.padding.top, l.padding.right, l.padding.bottom, l.padding.left,
            l.margin.top, l.margin.right, l.margin.bottom, l.margin.left,
            o.left, o.top, o.right, o.bottom,
            l.scrollbar_size.width, l.scrollbar_size.height,
        ];
        dst[..out::LEN].copy_from_slice(&v);
        true
    }
}
