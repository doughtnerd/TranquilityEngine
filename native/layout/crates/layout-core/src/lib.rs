//! Myco's UI layout tree (ADR 0433): Taffy's layout algorithms over our own node store (`tree.rs`, which resolves
//! `calc()`), behind small numeric handles and four style setters (enums, lengths, `calc()` lengths, numbers), so the
//! WebAssembly boundary passes only numbers. A measured leaf
//! (text, a replaced element) asks a callback for its size; everything else is laid out by Taffy's CSS
//! flexbox, grid and block algorithms. Rounding is off: boxes are exact in UI pixels.
//!
//! The property and value codes below are mirrored by `src/engine/ui/taffy/layoutTree.ts`; change both
//! together.

use taffy::prelude::*;
/// What a measured leaf is told about the room on an axis.
pub use taffy::style::AvailableSpace;
use taffy::style::{AlignContent, AlignItems, BoxSizing, Direction, Overflow};

mod tree;
use tree::{CalcValue, Node, Nodes, CALC_SLOTS};

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

/// Length kinds (`set_length`). `AUTO` on padding, border and gap (which have no auto) sets 0. A `calc()` length
/// mixing pixels and a percentage is set with `set_calc`.
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
#[derive(Default)]
pub struct UiLayout {
    nodes: Nodes,
    free: Vec<u32>,
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


/// A length property's new value: plain (a kind and number) or a `calc()` handle.
#[derive(Clone, Copy)]
enum Length {
    Plain(u8, f32),
    Calc(taffy::CalcHandle),
}

fn apply_length(s: &mut Style, prop: u8, value: Length) {
    let l = |_: u8| match value {
        Length::Plain(k, v) => lpa(k, v),
        Length::Calc(c) => LengthPercentageAuto::calc(c),
    };
    let p = || match value {
        Length::Plain(k, v) => lp(k, v),
        Length::Calc(c) => LengthPercentage::calc(c),
    };
    let d = || match value {
        Length::Plain(k, v) => dim(k, v),
        Length::Calc(c) => Dimension::calc(c),
    };
    match prop {
        prop_length::WIDTH => s.size.width = d(),
        prop_length::HEIGHT => s.size.height = d(),
        prop_length::MIN_WIDTH => s.min_size.width = l(0),
        prop_length::MIN_HEIGHT => s.min_size.height = l(0),
        prop_length::MAX_WIDTH => s.max_size.width = l(0),
        prop_length::MAX_HEIGHT => s.max_size.height = l(0),
        prop_length::FLEX_BASIS => s.flex_basis = d(),
        p_ @ prop_length::MARGIN_TOP..=10 => *side(&mut s.margin, p_ - prop_length::MARGIN_TOP) = l(0),
        p_ @ prop_length::PADDING_TOP..=14 => *side_lp(&mut s.padding, p_ - prop_length::PADDING_TOP) = p(),
        p_ @ prop_length::BORDER_TOP..=18 => *side_lp(&mut s.border, p_ - prop_length::BORDER_TOP) = p(),
        p_ @ prop_length::INSET_TOP..=22 => *side(&mut s.inset, p_ - prop_length::INSET_TOP) = l(0),
        prop_length::COLUMN_GAP => s.gap.width = p(),
        prop_length::ROW_GAP => s.gap.height = p(),
        _ => {}
    }
}

impl UiLayout {
    /// An empty tree. Boxes aren't rounded: they are exact in UI pixels.
    pub fn new() -> Self {
        Self::default()
    }

    /// A new node with the initial style; `measured` leaves ask the measure callback for their size.
    pub fn create(&mut self, measured: bool) -> u32 {
        let node = Some(Node::new(initial_style(), measured));
        match self.free.pop() {
            Some(h) => {
                self.nodes.slots[h as usize] = node;
                h
            }
            None => {
                self.nodes.slots.push(node);
                (self.nodes.slots.len() - 1) as u32
            }
        }
    }

    /// Removes a node (detaching it from its parent and its children from it); its handle may be reused.
    pub fn remove(&mut self, h: u32) {
        let Some(node) = self.nodes.slots.get_mut(h as usize).and_then(|n| n.take()) else { return };
        if let Some(p) = node.parent {
            if let Some(parent) = self.nodes.get_mut(p) {
                parent.children.retain(|c| usize::from(*c) != h as usize);
            }
            self.nodes.mark_dirty(p);
        }
        for c in node.children {
            if let Some(child) = self.nodes.get_mut(usize::from(c) as u32) {
                child.parent = None;
            }
        }
        self.free.push(h);
    }

    /// The node's children, in order (each detached from any earlier parent). Unknown handles are skipped.
    pub fn set_children(&mut self, h: u32, children: &[u32]) {
        if self.nodes.get(h).is_none() {
            return;
        }
        let kids: Vec<u32> = children.iter().copied().filter(|&c| c != h && self.nodes.get(c).is_some()).collect();
        // The old children leave; the new ones leave any other parent.
        let old = std::mem::take(&mut self.nodes.get_mut(h).unwrap().children);
        for c in old {
            if let Some(child) = self.nodes.get_mut(usize::from(c) as u32) {
                if child.parent == Some(h) {
                    child.parent = None;
                }
            }
        }
        for &c in &kids {
            let former = self.nodes.get(c).unwrap().parent;
            if let Some(p) = former.filter(|&p| p != h) {
                if let Some(parent) = self.nodes.get_mut(p) {
                    parent.children.retain(|x| usize::from(*x) != c as usize);
                }
                self.nodes.mark_dirty(p);
            }
            self.nodes.get_mut(c).unwrap().parent = Some(h);
        }
        self.nodes.get_mut(h).unwrap().children = kids.iter().map(|&c| NodeId::from(c as usize)).collect();
        self.nodes.mark_dirty(h);
    }

    /// How many children the node has.
    pub fn child_count(&self, h: u32) -> usize {
        self.nodes.get(h).map(|n| n.children.len()).unwrap_or(0)
    }

    /// Changes the node's style in place and marks it (and its ancestors) for layout.
    fn edit(&mut self, h: u32, f: impl FnOnce(&mut Style)) -> bool {
        let Some(node) = self.nodes.get_mut(h) else { return false };
        f(&mut node.style);
        self.nodes.mark_dirty(h);
        true
    }

    /// Sets a length property, dropping any `calc()` value it held.
    fn put_length(&mut self, h: u32, prop: u8, value: Length) -> bool {
        let Some(node) = self.nodes.get_mut(h) else { return false };
        if (prop as usize) < CALC_SLOTS {
            // The style's old handle (if any) is replaced in this same call, before the box it points at goes.
            let old = node.calcs[prop as usize].take();
            apply_length(&mut node.style, prop, value);
            drop(old);
        }
        self.nodes.mark_dirty(h);
        true
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
        self.put_length(h, prop, Length::Plain(k, v))
    }

    /// Sets a length property to `calc(px + percent%)`, its percentage resolved against the property's CSS basis at
    /// layout (the containing block's width for widths, margins and padding, its height for heights, and so on).
    pub fn set_calc(&mut self, h: u32, prop: u8, px: f32, percent: f32) -> bool {
        if (prop as usize) >= CALC_SLOTS || !px.is_finite() || !percent.is_finite() {
            return self.put_length(h, prop, Length::Plain(kind::AUTO, 0.0));
        }
        let Some(node) = self.nodes.get_mut(h) else { return false };
        let (value, handle) = CalcValue::boxed(px, percent / 100.0);
        let old = node.calcs[prop as usize].replace(value);
        apply_length(&mut node.style, prop, Length::Calc(handle));
        drop(old);
        self.nodes.mark_dirty(h);
        true
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
        self.nodes.mark_dirty(h);
    }

    /// Lays out the tree under `root` in the given space (a finite size is definite; `+inf` or NaN is
    /// max-content, `-inf` min-content). Measured leaves get their size (and first baseline) from `measure(handle, input)`.
    pub fn compute(&mut self, root: u32, width: f32, height: f32, mut measure: impl FnMut(u32, MeasureInput) -> Measured) {
        let space = |v: f32| {
            if v.is_finite() {
                AvailableSpace::Definite(v)
            } else if v == f32::NEG_INFINITY {
                AvailableSpace::MinContent
            } else {
                AvailableSpace::MaxContent
            }
        };
        self.nodes.compute(root, Size { width: space(width), height: space(height) }, &mut measure);
    }

    /// Writes the node's computed box (`out::LEN` floats, laid out as `out` says) into `dst`; zeros for an
    /// unknown handle. Returns false when `dst` is too short or the handle is unknown.
    pub fn layout(&self, h: u32, dst: &mut [f32]) -> bool {
        if dst.len() < out::LEN {
            return false;
        }
        let Some(node) = self.nodes.get(h) else {
            dst[..out::LEN].fill(0.0);
            return false;
        };
        let l = &node.layout;
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
