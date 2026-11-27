//! layout-core through its public interface: handles, setters, compute, layout.
use layout_core::*;

fn boxed(l: &UiLayout, h: u32) -> [f32; 4] {
    let mut o = [0.0; out::LEN];
    assert!(l.layout(h, &mut o));
    [o[0], o[1], o[2], o[3]]
}

fn px(l: &mut UiLayout, h: u32, p: u8, v: f32) {
    assert!(l.set_length(h, p, kind::PX, v));
}

fn column(l: &mut UiLayout) -> u32 {
    let h = l.create(false);
    l.set_enum(h, prop_enum::FLEX_DIRECTION, 1);
    h
}

/// The King of Pirates HUD case (ADR 0434): Yoga skips laying out the children of a fit-content node with
/// no room across and gives `#lines` the whole height (684), pushing the bottom bar to 760. A browser,
/// and Taffy, give 24 and 640.
#[test]
fn hud_with_an_empty_middle_keeps_the_bottom_bar_on_screen() {
    let mut l = UiLayout::new();
    let root = column(&mut l);
    px(&mut l, root, prop_length::WIDTH, 1280.0);
    px(&mut l, root, prop_length::HEIGHT, 720.0);
    l.set_enum(root, prop_enum::JUSTIFY_CONTENT, content::SPACE_BETWEEN);
    let top = l.create(false);
    px(&mut l, top, prop_length::HEIGHT, 40.0);
    let row = l.create(false);
    l.set_enum(row, prop_enum::JUSTIFY_CONTENT, content::CENTER);
    let panel = column(&mut l);
    l.set_enum(panel, prop_enum::ALIGN_ITEMS, items::CENTER);
    for i in 0..4 {
        px(&mut l, panel, prop_length::PADDING_TOP + i, 18.0);
    }
    let lines = column(&mut l);
    l.set_enum(lines, prop_enum::ALIGN_ITEMS, items::CENTER);
    let line = l.create(false);
    px(&mut l, line, prop_length::WIDTH, 0.0);
    px(&mut l, line, prop_length::HEIGHT, 24.0);
    let bottom = l.create(false);
    px(&mut l, bottom, prop_length::HEIGHT, 80.0);
    l.set_children(lines, &[line]);
    l.set_children(panel, &[lines]);
    l.set_children(row, &[panel]);
    l.set_children(root, &[top, row, bottom]);
    l.compute(root, 1280.0, 720.0, |_, _| Measured::size(0.0, 0.0));
    assert_eq!(boxed(&l, lines)[3], 24.0);
    assert_eq!(boxed(&l, panel), [622.0, 0.0, 36.0, 60.0]);
    assert_eq!(boxed(&l, bottom), [0.0, 640.0, 1280.0, 80.0]);
}

#[test]
fn measured_leaves_get_their_size_from_the_callback_and_wrap_to_the_room() {
    let mut l = UiLayout::new();
    let root = l.create(false);
    px(&mut l, root, prop_length::WIDTH, 100.0);
    l.set_enum(root, prop_enum::ALIGN_ITEMS, items::FLEX_START);
    let text = l.create(true);
    l.set_children(root, &[text]);
    // 300 px of text in 10 px-tall lines of at most the available width.
    let mut calls = Vec::new();
    l.compute(root, 100.0, f32::INFINITY, |h, input| {
        calls.push((h, input));
        let room = match input.known_width {
            Some(w) => w,
            None => match input.available_width {
                AvailableSpace::Definite(w) => w,
                AvailableSpace::MinContent => 30.0,
                AvailableSpace::MaxContent => f32::INFINITY,
            },
        };
        let w = room.min(300.0);
        Measured::size(w, (300.0 / w).ceil() * 10.0)
    });
    assert!(calls.iter().all(|(h, _)| *h == text));
    assert_eq!(boxed(&l, text), [0.0, 0.0, 100.0, 30.0]);
    assert_eq!(boxed(&l, root)[3], 30.0);
}

#[test]
fn a_dirty_measured_leaf_is_measured_again() {
    let mut l = UiLayout::new();
    let root = l.create(false);
    let text = l.create(true);
    l.set_children(root, &[text]);
    let mut size = 10.0;
    l.compute(root, 200.0, 200.0, |_, _| Measured::size(size, size));
    assert_eq!(boxed(&l, text)[2], 10.0);
    size = 20.0;
    l.compute(root, 200.0, 200.0, |_, _| Measured::size(size, size));
    assert_eq!(boxed(&l, text)[2], 10.0, "cached until marked dirty");
    l.mark_dirty(text);
    l.compute(root, 200.0, 200.0, |_, _| Measured::size(size, size));
    assert_eq!(boxed(&l, text)[2], 20.0);
}

#[test]
fn absolute_children_sit_against_their_parent_padding_box() {
    let mut l = UiLayout::new();
    let root = l.create(false);
    px(&mut l, root, prop_length::WIDTH, 400.0);
    px(&mut l, root, prop_length::HEIGHT, 300.0);
    let parent = l.create(false);
    px(&mut l, parent, prop_length::MARGIN_TOP + 3, 50.0);
    px(&mut l, parent, prop_length::WIDTH, 200.0);
    px(&mut l, parent, prop_length::HEIGHT, 100.0);
    px(&mut l, parent, prop_length::BORDER_TOP, 5.0);
    let abs = l.create(false);
    l.set_enum(abs, prop_enum::POSITION, 1);
    px(&mut l, abs, prop_length::INSET_TOP + 1, 10.0);
    px(&mut l, abs, prop_length::INSET_TOP + 2, 10.0);
    px(&mut l, abs, prop_length::WIDTH, 20.0);
    px(&mut l, abs, prop_length::HEIGHT, 20.0);
    l.set_children(parent, &[abs]);
    l.set_children(root, &[parent]);
    l.compute(root, 400.0, 300.0, |_, _| Measured::size(0.0, 0.0));
    assert_eq!(boxed(&l, abs), [170.0, 70.0, 20.0, 20.0]);
}

#[test]
fn percentages_gap_wrap_and_auto_margins() {
    let mut l = UiLayout::new();
    let root = l.create(false);
    px(&mut l, root, prop_length::WIDTH, 300.0);
    px(&mut l, root, prop_length::HEIGHT, 200.0);
    l.set_enum(root, prop_enum::FLEX_WRAP, 1);
    l.set_enum(root, prop_enum::ALIGN_CONTENT, content::FLEX_START);
    px(&mut l, root, prop_length::COLUMN_GAP, 10.0);
    px(&mut l, root, prop_length::ROW_GAP, 5.0);
    let kids: Vec<u32> = (0..3)
        .map(|_| {
            let k = l.create(false);
            assert!(l.set_length(k, prop_length::WIDTH, kind::PERCENT, 40.0));
            px(&mut l, k, prop_length::HEIGHT, 20.0);
            k
        })
        .collect();
    l.set_length(kids[2], prop_length::MARGIN_TOP + 3, kind::AUTO, 0.0);
    l.set_children(root, &kids);
    l.compute(root, 300.0, 200.0, |_, _| Measured::size(0.0, 0.0));
    assert_eq!(boxed(&l, kids[0]), [0.0, 0.0, 120.0, 20.0]);
    assert_eq!(boxed(&l, kids[1]), [130.0, 0.0, 120.0, 20.0]);
    assert_eq!(boxed(&l, kids[2]), [180.0, 25.0, 120.0, 20.0]);
}

#[test]
fn display_none_and_removed_nodes_take_no_room() {
    let mut l = UiLayout::new();
    let root = l.create(false);
    px(&mut l, root, prop_length::WIDTH, 100.0);
    let a = l.create(false);
    let b = l.create(false);
    let c = l.create(false);
    for k in [a, b, c] {
        px(&mut l, k, prop_length::WIDTH, 30.0);
    }
    l.set_children(root, &[a, b, c]);
    l.set_enum(a, prop_enum::DISPLAY, 1);
    l.remove(b);
    assert_eq!(l.child_count(root), 2);
    l.compute(root, 100.0, 100.0, |_, _| Measured::size(0.0, 0.0));
    assert_eq!(boxed(&l, c)[0], 0.0);
    // The freed handle is reused.
    assert_eq!(l.create(false), b);
}

#[test]
fn moving_a_child_to_another_parent_detaches_it() {
    let mut l = UiLayout::new();
    let p1 = l.create(false);
    let p2 = l.create(false);
    let k = l.create(false);
    l.set_children(p1, &[k]);
    l.set_children(p2, &[k]);
    assert_eq!(l.child_count(p1), 0);
    assert_eq!(l.child_count(p2), 1);
}

#[test]
fn min_content_sizing_keeps_items_at_their_content_size() {
    // Automatic minimum size (CSS's min-width: auto), which Yoga lacks: a text item doesn't shrink below its
    // longest word in a too-narrow row.
    let mut l = UiLayout::new();
    let root = l.create(false);
    px(&mut l, root, prop_length::WIDTH, 50.0);
    let text = l.create(true);
    l.set_children(root, &[text]);
    l.compute(root, 50.0, f32::INFINITY, |_, input| match input.available_width {
        AvailableSpace::MinContent => Measured::size(80.0, 20.0),
        _ => Measured::size(160.0, 10.0),
    });
    assert_eq!(boxed(&l, text)[2], 80.0);
}

#[test]
fn unknown_handles_are_ignored() {
    let mut l = UiLayout::new();
    assert!(!l.set_enum(7, prop_enum::DISPLAY, 1));
    let mut o = [1.0; out::LEN];
    assert!(!l.layout(7, &mut o));
    assert!(o.iter().all(|v| *v == 0.0));
    l.remove(7);
    l.compute(7, 1.0, 1.0, |_, _| Measured::size(0.0, 0.0));
}

#[test]
fn baseline_alignment_uses_measured_first_baselines() {
    // A row aligning on baselines: text A (20 tall, baseline 16) with 4 px of top padding, text B (40 tall, baseline 30),
    // and a box with no baseline (CSS synthesises one at its bottom edge).
    let mut l = UiLayout::new();
    let root = l.create(false);
    px(&mut l, root, prop_length::WIDTH, 300.0);
    l.set_enum(root, prop_enum::ALIGN_ITEMS, items::BASELINE);
    let a = l.create(true);
    px(&mut l, a, prop_length::PADDING_TOP, 4.0);
    let b = l.create(true);
    let boxed_ = l.create(false);
    px(&mut l, boxed_, prop_length::WIDTH, 10.0);
    px(&mut l, boxed_, prop_length::HEIGHT, 10.0);
    l.set_children(root, &[a, b, boxed_]);
    l.compute(root, 300.0, 200.0, |h, _| if h == a { Measured { width: 50.0, height: 20.0, baseline: Some(16.0) } } else { Measured { width: 50.0, height: 40.0, baseline: Some(30.0) } });
    // Baselines from the top: A 4 + 16 = 20, B 30, the box 10. All meet at B's 30.
    assert_eq!(boxed(&l, a)[1], 10.0);
    assert_eq!(boxed(&l, b)[1], 0.0);
    assert_eq!(boxed(&l, boxed_)[1], 20.0);
}

#[test]
fn calc_lengths_resolve_against_their_css_basis_during_layout() {
    // calc(50% + -12px) wide, calc(100% - 20px) tall, padding calc(10% + 2px) (of the width), in a 400 x 300 box.
    let mut l = UiLayout::new();
    let root = l.create(false);
    px(&mut l, root, prop_length::WIDTH, 400.0);
    px(&mut l, root, prop_length::HEIGHT, 300.0);
    l.set_enum(root, prop_enum::ALIGN_ITEMS, items::FLEX_START);
    let a = l.create(false);
    assert!(l.set_calc(a, prop_length::WIDTH, -12.0, 50.0));
    assert!(l.set_calc(a, prop_length::HEIGHT, -20.0, 100.0));
    assert!(l.set_calc(a, prop_length::PADDING_TOP + 3, 2.0, 10.0));
    let b = l.create(false);
    assert!(l.set_calc(b, prop_length::MARGIN_TOP + 3, 5.0, 25.0));
    px(&mut l, b, prop_length::WIDTH, 10.0);
    px(&mut l, b, prop_length::HEIGHT, 10.0);
    l.set_children(root, &[a, b]);
    l.compute(root, 400.0, 300.0, |_, _| Measured::size(0.0, 0.0));
    assert_eq!(boxed(&l, a), [0.0, 0.0, 188.0, 280.0]);
    let mut o = [0.0; out::LEN];
    l.layout(a, &mut o);
    assert_eq!(o[out::PADDING + 3], 42.0);
    assert_eq!(boxed(&l, b)[0], 188.0 + 105.0);
    // The parent grows: the same calc() follows it in one layout.
    px(&mut l, root, prop_length::WIDTH, 600.0);
    l.compute(root, 600.0, 300.0, |_, _| Measured::size(0.0, 0.0));
    assert_eq!(boxed(&l, a)[2], 288.0);
    // A plain length replaces the calc() (its value is dropped), and back again.
    px(&mut l, a, prop_length::PADDING_TOP + 3, 0.0);
    px(&mut l, a, prop_length::WIDTH, 50.0);
    l.compute(root, 600.0, 300.0, |_, _| Measured::size(0.0, 0.0));
    assert_eq!(boxed(&l, a)[2], 50.0);
    l.set_calc(a, prop_length::WIDTH, 0.0, 10.0);
    l.compute(root, 600.0, 300.0, |_, _| Measured::size(0.0, 0.0));
    assert_eq!(boxed(&l, a)[2], 60.0);
}

#[test]
fn calc_in_nested_percentages_needs_no_second_pass() {
    // Each level is calc(50% + 10px) of the one above: 400 -> 210 -> 115 -> 67.5, in one compute.
    let mut l = UiLayout::new();
    let root = l.create(false);
    px(&mut l, root, prop_length::WIDTH, 400.0);
    px(&mut l, root, prop_length::HEIGHT, 100.0);
    let mut parent = root;
    let mut levels = Vec::new();
    for _ in 0..3 {
        let n = l.create(false);
        l.set_calc(n, prop_length::WIDTH, 10.0, 50.0);
        l.set_children(parent, &[n]);
        levels.push(n);
        parent = n;
    }
    l.compute(root, 400.0, 100.0, |_, _| Measured::size(0.0, 0.0));
    let widths: Vec<f32> = levels.iter().map(|&n| boxed(&l, n)[2]).collect();
    assert_eq!(widths, vec![210.0, 115.0, 67.5]);
}

#[test]
fn removing_a_node_with_calc_values_and_reusing_its_handle_is_safe() {
    let mut l = UiLayout::new();
    let root = l.create(false);
    px(&mut l, root, prop_length::WIDTH, 100.0);
    let a = l.create(false);
    l.set_calc(a, prop_length::WIDTH, 1.0, 50.0);
    l.set_children(root, &[a]);
    l.compute(root, 100.0, 100.0, |_, _| Measured::size(0.0, 0.0));
    l.remove(a);
    let b = l.create(false);
    assert_eq!(b, a);
    l.set_children(root, &[b]);
    l.compute(root, 100.0, 100.0, |_, _| Measured::size(0.0, 0.0));
    assert_eq!(boxed(&l, b)[2], 0.0);
}
