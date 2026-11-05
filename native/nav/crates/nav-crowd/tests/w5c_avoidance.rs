//! Wave 5c: neighbour grids, ORCA avoidance, layers and priorities, making way, obstacles, flight separation. Ports
//! Foxfire's `NavNeighborGridTests` and drives the avoidance step on real bakes with a test-side mover (see
//! `w5c_common.rs`).
#[path = "w5c_common.rs"]
mod w5c_common;

use nav_crowd::agents::AgentDesc;
use nav_crowd::avoidance::{self, BodyKind, NeighborBody, NeighborGrid};
use nav_crowd::components::{NavGroup, NavGroupMember};
use nav_crowd::settings::{AgentTypeSettings, AgentTypes, NavAvoidance, NavFlightAgent, NavMeshAgent};
use nav_math::{Float3, Hash128, Int3};
use w5c_common::bake_common::Rng;
use w5c_common::*;

fn v3(x: f32, y: f32, z: f32) -> Float3 {
    Float3::new(x, y, z)
}

// ------------------------------------------------------------------------------------------------- the neighbour grid

fn agent_body(owner: i32, position: Float3, neighbor_distance: f32) -> NeighborBody {
    NeighborBody {
        position,
        up: UP,
        radius: 0.5,
        height: 2.0,
        neighbor_distance,
        layers: 1,
        owner,
        kind: BodyKind::Steering,
        ..NeighborBody::default()
    }
}

fn random_point(rng: &mut Rng, lo: Float3, hi: Float3) -> Float3 {
    v3(rng.range(lo.x, hi.x), rng.range(lo.y, hi.y), rng.range(lo.z, hi.z))
}

#[test]
fn buckets_find_exactly_the_bodies_in_range() {
    let mut rng = Rng::new(7);
    let (agents, obstacles) = (400, 6);
    let mut bodies = Vec::new();
    for i in 0..agents {
        bodies.push(agent_body(i, random_point(&mut rng, v3(-80.0, 0.0, -80.0), v3(80.0, 4.0, 80.0)), if i % 3 == 0 { 6.0 } else { 3.0 }));
    }
    for i in 0..obstacles {
        bodies.push(NeighborBody {
            position: random_point(&mut rng, v3(-60.0, 0.0, -60.0), v3(60.0, 0.0, 60.0)),
            up: UP,
            radius: 9.0, // bigger than the cell: spans several
            height: 4.0,
            layers: 1,
            owner: -1 - i,
            kind: BodyKind::Obstacle,
            ..NeighborBody::default()
        });
    }
    let grid = NeighborGrid::from_bodies(bodies.clone());

    let cell = grid.cell_size;
    assert!(cell.x >= 3.0, "cells at least half the largest neighbour distance across");
    assert!(cell.x >= 2.0, "cells at least 4 agent radii across");
    assert_eq!(cell.x, cell.z, "square across");
    assert!(cell.y >= 6.0, "cells at least 3 agent heights tall");
    assert_eq!(*grid.bucket_start.last().unwrap() as usize, grid.bodies.len(), "every entry in a bucket");
    assert!(grid.bodies.len() > bodies.len(), "obstacles appear in several cells");

    let buckets = grid.bucket_start.len() - 1;
    for b in 0..buckets {
        for k in grid.bucket_start[b]..grid.bucket_start[b + 1] {
            assert_eq!((avoidance::hash_int3(grid.cells[k as usize]) as usize) & (buckets - 1), b, "entry in the wrong bucket");
        }
    }

    for q in 0..50 {
        let p = random_point(&mut rng, v3(-90.0, 0.0, -90.0), v3(90.0, 4.0, 90.0));
        let range = 6.0;
        let mut found = std::collections::BTreeSet::new();
        let lo = avoidance::cell_of(p - Float3::splat(range), cell);
        let hi = avoidance::cell_of(p + Float3::splat(range), cell);
        for z in lo.z..=hi.z {
            for y in lo.y..=hi.y {
                for x in lo.x..=hi.x {
                    let at = Int3::new(x, y, z);
                    let (s, e) = grid.bucket(at);
                    for k in s..e {
                        if grid.cells[k] == at && grid.bodies[k].kind != BodyKind::Obstacle && grid.bodies[k].position.distance(p) <= range {
                            found.insert(grid.gather_index(k));
                        }
                    }
                }
            }
        }
        let mut expected = 0;
        for (i, b) in bodies.iter().take(agents as usize).enumerate() {
            if b.position.distance(p) > range {
                continue;
            }
            expected += 1;
            assert!(found.contains(&(i as i32)), "query {q}: agent {i} in range but not found");
        }
        assert_eq!(expected, found.len(), "query {q}: found agents out of range or twice");
    }
}

#[test]
fn find_neighbors_skipping_far_cells_finds_the_same_nearest_as_brute_force() {
    let mut rng = Rng::new(11);
    let (crowd, sparse, obstacles) = (600, 200, 4);
    let mut bodies = Vec::new();
    for i in 0..crowd + sparse {
        let p = if i < crowd {
            random_point(&mut rng, v3(-10.0, 0.0, -10.0), v3(10.0, 1.0, 10.0))
        } else {
            random_point(&mut rng, v3(-60.0, -3.0, -60.0), v3(60.0, 6.0, 60.0))
        };
        bodies.push(agent_body(i, p, 6.0));
    }
    for i in 0..obstacles {
        bodies.push(NeighborBody {
            position: random_point(&mut rng, v3(-30.0, 0.0, -30.0), v3(30.0, 0.0, 30.0)),
            up: UP,
            radius: 5.0,
            height: 4.0,
            layers: 1,
            owner: -1 - i,
            kind: BodyKind::Obstacle,
            ..NeighborBody::default()
        });
    }
    let grid = NeighborGrid::from_bodies(bodies.clone());
    let avoidance = NavAvoidance { neighbor_distance: 6.0, max_neighbors: 10, ..NavAvoidance::default() };
    let height = 2.0;
    for q in 0..200 {
        let pos = if q % 2 == 0 {
            random_point(&mut rng, v3(-12.0, 0.0, -12.0), v3(12.0, 1.0, 12.0))
        } else {
            random_point(&mut rng, v3(-60.0, -3.0, -60.0), v3(60.0, 6.0, 60.0))
        };
        let mut up = UP;
        if q % 4 == 1 {
            let tilted = v3(rng.range(-0.12, 0.12), 1.0, rng.range(-0.12, 0.12)).normalize();
            if tilted.y.abs() > 0.99 {
                up = tilted; // upright queries only: the 3D path searches every cell anyway
            }
        }
        let (mut n, mut d) = (Vec::new(), Vec::new());
        grid.find_neighbors(i32::MAX, pos, up, &avoidance, height, &mut n, &mut d, 0);

        let mut expected = Vec::new();
        for b in &bodies {
            let obstacle = b.kind == BodyKind::Obstacle;
            let rel = (if obstacle { b.center() } else { b.position }) - pos;
            let h = rel.dot(up);
            let low = if obstacle { h - b.height * 0.5 } else { h };
            let high = if obstacle { h + b.height * 0.5 } else { h + b.height };
            if high < 0.0 || low > height {
                continue;
            }
            let reach = avoidance.neighbor_distance + if obstacle { b.radius } else { 0.0 };
            let d2 = (rel - up * h).length_sq();
            if d2 <= reach * reach {
                expected.push(d2);
            }
        }
        expected.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let want = expected.len().min(avoidance.max_neighbors as usize);
        assert_eq!(want, n.len(), "query {q} at {pos:?}: neighbour count");
        for k in 0..want {
            assert!((expected[k] - d[k]).abs() < 1e-4, "query {q} at {pos:?}: neighbour {k} isn't the {k}th nearest");
        }
    }
}

fn flyer_settings() -> NavFlightAgent {
    NavFlightAgent { radius: 1.0, separation_strength: 1.0, separation_radius_scale: 1.5, layers: 1, avoid_layers: 1, ..NavFlightAgent::default() }
}

fn flyer_body(owner: i32, position: Float3, personal: f32, layers: u32) -> NeighborBody {
    NeighborBody { position, up: UP, radius: personal, neighbor_distance: 2.0 * personal, layers, owner, kind: BodyKind::Steering, airborne: true, ..NeighborBody::default() }
}

#[test]
fn flyer_separation_pushes_off_overlapping_flyers_only() {
    // Personal space 1.5 (radius 1 x 1.5): two flyers overlap while closer than 3; the push grows from 0 at touching to
    // strength x speed.
    let speed = 10.0;
    let flyer = flyer_settings();
    let origin = v3(100.0, 50.0, 100.0);
    let mut walker = agent_body(5, origin - v3(0.0, 0.5, 0.0), 6.0);
    walker.radius = 1.0;
    let grid = NeighborGrid::from_bodies(vec![
        flyer_body(1, origin, 1.5, 1),
        flyer_body(2, origin + v3(1.0, 0.0, 0.0), 1.5, 1), // 1 away: overlap 2/3
        flyer_body(3, origin + v3(0.0, 0.0, 3.5), 1.5, 1), // past 3: no overlap
        flyer_body(4, origin + v3(0.0, -1.0, 0.0), 1.5, 2), // overlaps, on a layer self doesn't avoid
        walker,                                            // right underneath: not airborne, ignored
        flyer_body(6, origin + v3(-40.0, 0.0, 0.0), 1.5, 1),
    ]);
    let steered = avoidance::separation_steer(&grid, 1, origin, Float3::default(), speed, &flyer, 0);
    assert!((steered.x + speed * (1.0 - 1.0 / 3.0)).abs() < 1e-3, "pushed straight away from the near flyer, by its overlap: {steered:?}");
    assert!(steered.y.abs() < 1e-4, "not by the flyer on another layer, nor the walker below");
    assert!(steered.z.abs() < 1e-4, "not by the flyer 3.5 away");

    let pushed_back = avoidance::separation_steer(&grid, 2, origin + v3(1.0, 0.0, 0.0), Float3::default(), speed, &flyer, 0);
    assert!((pushed_back.x + steered.x).abs() < 1e-3, "the pair push each other equally apart");

    let cruising = avoidance::separation_steer(&grid, 1, origin, v3(0.0, 0.0, speed), speed, &flyer, 0);
    assert!(cruising.length() <= speed + 1e-3, "never faster than its speed, pushes included");
    assert!(cruising.x < 0.0, "still pushed aside while it flies");

    let alone = avoidance::separation_steer(&grid, 6, origin + v3(-40.0, 0.0, 0.0), v3(3.0, 0.0, 0.0), speed, &flyer, 0);
    assert_eq!(alone, v3(3.0, 0.0, 0.0), "nothing overlaps: it flies as it wants");

    // Two flyers in exactly the same spot part in opposite directions.
    let stacked = NeighborGrid::from_bodies(vec![flyer_body(1, origin, 1.5, 1), flyer_body(2, origin, 1.5, 1)]);
    let a = avoidance::separation_steer(&stacked, 1, origin, Float3::default(), speed, &flyer, 0);
    let b = avoidance::separation_steer(&stacked, 2, origin, Float3::default(), speed, &flyer, 0);
    assert!((a.length() - speed).abs() < 1e-3, "fully overlapped: pushed at full speed");
    assert!((a.normalize().dot(b.normalize()) + 1.0).abs() < 1e-3, "in opposite directions");
}

#[test]
fn flyer_separation_passing_through_its_group_ignores_only_that_groups_members() {
    let speed = 10.0;
    let flyer = flyer_settings();
    let origin = v3(100.0, 50.0, 100.0);
    let mut mate = flyer_body(2, origin + v3(1.0, 0.0, 0.0), 1.5, 1);
    mate.group = 7;
    let mut stranger = flyer_body(3, origin + v3(0.0, 0.0, 1.0), 1.5, 1);
    stranger.group = 8;
    let grid = NeighborGrid::from_bodies(vec![flyer_body(1, origin, 1.5, 1), mate, stranger]);
    let both = avoidance::separation_steer(&grid, 1, origin, Float3::default(), speed, &flyer, 0);
    assert!(both.x < 0.0, "not passing through: pushed off its group's member");
    let through = avoidance::separation_steer(&grid, 1, origin, Float3::default(), speed, &flyer, 7);
    assert!(through.x.abs() < 1e-4, "passing through group 7: not pushed off its member");
    assert!(through.z < 0.0, "still pushed off another group's member");
}

#[test]
fn try_get_body_finds_this_ticks_bodies_and_rejects_others() {
    let big = NeighborBody { position: v3(0.0, 0.0, 0.0), up: UP, radius: 20.0, height: 2.0, layers: 1, owner: -1 - 5, kind: BodyKind::Obstacle, ..NeighborBody::default() };
    let grid = NeighborGrid::from_bodies(vec![flyer_body(3, v3(0.0, 0.0, 0.0), 1.0, 1), flyer_body(7, v3(9.0, 0.0, 0.0), 1.0, 1), big]);
    assert!(grid.bodies.len() > 3, "the obstacle is in several cells");
    for owner in [3, 7, -1 - 5] {
        let k = grid.try_get_body(owner).unwrap_or_else(|| panic!("owner {owner} is a body"));
        assert_eq!(grid.bodies[k].owner, owner);
    }
    assert!(grid.try_get_body(1).is_none(), "an index never written");
    assert!(grid.try_get_body(1000).is_none(), "past the array");
    assert!(grid.try_get_body(-1 - 1000).is_none());
}

#[test]
fn neighbour_cache_with_nothing_moved_finds_what_the_search_found_and_drops_what_left_range() {
    let mut rng = Rng::new(7);
    let bodies: Vec<NeighborBody> =
        (0..300).map(|i| agent_body(i, random_point(&mut rng, v3(-10.0, 0.0, -10.0), v3(10.0, 0.0, 10.0)), 6.0)).collect();
    let grid = NeighborGrid::from_bodies(bodies);
    let avoidance = NavAvoidance { neighbor_distance: 6.0, max_neighbors: 10, ..NavAvoidance::default() };
    for q in 0..50 {
        let pos = random_point(&mut rng, v3(-8.0, 0.0, -8.0), v3(8.0, 0.0, 8.0));
        let (mut found, mut found_d) = (Vec::new(), Vec::new());
        grid.find_neighbors(-1000, pos, UP, &avoidance, 2.0, &mut found, &mut found_d, 0);
        let owners: Vec<i32> = found.iter().map(|&j| grid.bodies[j as usize].owner).collect();

        let (mut cached, mut cached_d) = (Vec::new(), Vec::new());
        grid.cached_neighbors(owners.iter().copied(), -1000, pos, UP, &avoidance, 2.0, &mut cached, &mut cached_d);
        assert_eq!(found.len(), cached.len(), "query {q}: the same neighbours");
        for k in 0..found.len() {
            assert!((found_d[k] - cached_d[k]).abs() < 1e-5, "query {q}: neighbour {k}'s distance");
        }

        let (mut gone, mut gone_d) = (Vec::new(), Vec::new());
        grid.cached_neighbors(owners.iter().copied(), -1000, pos + v3(20.0, 0.0, 0.0), UP, &avoidance, 2.0, &mut gone, &mut gone_d);
        assert!(gone.is_empty(), "query {q}: out of range, dropped");
    }
}

// ------------------------------------------------------------------------------------------------- walkers

fn walker_types(avoidance: NavAvoidance) -> AgentTypes {
    let walk = NavMeshAgent { radius: 0.5, height: 2.0, step_height: 0.5, pivot_offset: 0.0, max_snap_distance: 2.0, speed: 4.0, ..NavMeshAgent::default() };
    AgentTypes::new(vec![AgentTypeSettings::walker("Walker", WALKER, walk).with_avoidance(avoidance)])
}

fn quick() -> NavAvoidance {
    NavAvoidance { neighbor_distance: 20.0, ..NavAvoidance::default() }
}

/// A walker that heads for `goal`; returns its row.
fn walker(sim: &mut Sim, from: Float3, tweak: impl FnOnce(&mut AgentDesc)) -> usize {
    sim.add_agent(WALKER, from, tweak)
}

/// First tick: chunk assignment, then the polygon seeds.
fn ready(sim: &mut Sim, rows: &[usize]) {
    sim.begin();
    for &r in rows {
        sim.seed_poly(r);
    }
}

#[test]
fn two_agents_walking_head_on_pass_without_overlapping() {
    let mut sim = Sim::new(vec![floor_chunk(20.0, &[])], walker_types(quick()));
    // Not exactly collinear: ORCA (RVO2) stalls an exactly symmetric head-on pair at the velocity obstacle's cutoff, and
    // real paths never are (RVO2's own demos add noise).
    let a = walker(&mut sim, v3(-10.0, 0.0, 0.1), |_| {});
    let b = walker(&mut sim, v3(10.0, 0.0, -0.1), |_| {});
    ready(&mut sim, &[a, b]);
    let (ga, gb) = (v3(10.0, 0.0, 0.1), v3(-10.0, 0.0, -0.1));
    let mut min_sep = f32::MAX;
    for _ in 0..420 {
        sim.begin();
        sim.head_for(a, ga, 0.3);
        sim.head_for(b, gb, 0.3);
        sim.neighbor_grids_and_avoid();
        sim.integrate();
        min_sep = min_sep.min(sim.distance(a, b));
    }
    assert!(min_sep >= 0.9, "they never overlapped (radii 0.5 + 0.5): closest {min_sep}");
    assert!(sim.agents.position[a].x > 9.0 && sim.agents.position[b].x < -9.0, "and got through: {:?} {:?}", sim.agents.position[a], sim.agents.position[b]);
}

#[test]
fn a_crowd_through_a_doorway_does_not_deadlock() {
    // A wall across x = 0 with a 3 m door at z = 0 (the navmesh keeps 2 m of it for radius 0.5 agents).
    let walls = [(v3(0.0, 1.0, -11.5), v3(1.0, 2.0, 20.0)), (v3(0.0, 1.0, 11.5), v3(1.0, 2.0, 20.0))];
    let mut sim = Sim::new(vec![floor_chunk(20.0, &walls)], walker_types(quick()));
    let n = 14;
    let mut rows = Vec::new();
    for i in 0..n {
        let (cx, cz) = ((i % 4) as f32, (i / 4) as f32);
        rows.push(walker(&mut sim, v3(-13.0 + cx * 1.6, 0.0, -2.4 + cz * 1.6), |_| {}));
    }
    ready(&mut sim, &rows);
    let mut done_at = None;
    for t in 0..4000 {
        sim.begin();
        for &r in &rows {
            let p = sim.agents.surface[r].surface_position;
            // Through the door first (a waypoint on each side), then on to the far goal.
            let goal = if p.x < -1.5 {
                v3(-0.8, 0.0, 0.0)
            } else if p.x < 1.2 {
                v3(2.0, 0.0, 0.0)
            } else {
                v3(12.0, 0.0, 0.0)
            };
            sim.head_for(r, goal, 0.3);
        }
        sim.neighbor_grids_and_avoid();
        sim.integrate();
        if rows.iter().all(|&r| sim.agents.position[r].x > 8.0) {
            done_at = Some(t);
            break;
        }
    }
    let done = done_at.unwrap_or_else(|| panic!("the crowd never got through: {:?}", rows.iter().map(|&r| sim.agents.position[r]).collect::<Vec<_>>()));
    assert!(done < 3500, "took {done} ticks");
    for &r in &rows {
        assert!((sim.agents.position[r].y - 0.2).abs() < 0.05, "stayed on the floor");
    }
}

/// How far an agent strayed from the line z = 0 over the run, for the priority test.
fn head_on_run(pri_a: i32, pri_b: i32, layers: (u32, u32), avoid_layers: (u32, u32)) -> (f32, f32, f32) {
    let mut sim = Sim::new(vec![floor_chunk(20.0, &[])], walker_types(quick()));
    let a = walker(&mut sim, v3(-10.0, 0.0, 0.1), |d| {
        d.avoidance_priority = Some(pri_a);
        d.avoidance_layers = Some(layers.0);
        d.avoid_layers = Some(avoid_layers.0);
    });
    let b = walker(&mut sim, v3(10.0, 0.0, -0.1), |d| {
        d.avoidance_priority = Some(pri_b);
        d.avoidance_layers = Some(layers.1);
        d.avoid_layers = Some(avoid_layers.1);
    });
    ready(&mut sim, &[a, b]);
    let (mut dev_a, mut dev_b, mut min_sep) = (0.0f32, 0.0f32, f32::MAX);
    for _ in 0..420 {
        sim.begin();
        sim.head_for(a, v3(10.0, 0.0, 0.1), 0.3);
        sim.head_for(b, v3(-10.0, 0.0, -0.1), 0.3);
        sim.neighbor_grids_and_avoid();
        sim.integrate();
        dev_a = dev_a.max((sim.agents.position[a].z - 0.1).abs());
        dev_b = dev_b.max((sim.agents.position[b].z + 0.1).abs());
        min_sep = min_sep.min(sim.distance(a, b));
    }
    (dev_a, dev_b, min_sep)
}

#[test]
fn a_high_priority_agent_is_pushed_less_and_masks_ignore_other_layers() {
    // Lower number = more important: A (10) takes 0.1 of the avoidance, B (90) takes 0.9.
    let (dev_a, dev_b, min_sep) = head_on_run(10, 90, (1, 1), (u32::MAX, u32::MAX));
    assert!(min_sep >= 0.85, "still no overlap: {min_sep}");
    assert!(dev_b > 3.0 * dev_a, "the important agent holds its line: A strayed {dev_a}, B {dev_b}");
    // The same the other way round.
    let (dev_a2, dev_b2, _) = head_on_run(90, 10, (1, 1), (u32::MAX, u32::MAX));
    assert!(dev_a2 > 3.0 * dev_b2, "{dev_a2} vs {dev_b2}");
    // Equal priorities share it.
    let (ea, eb, _) = head_on_run(50, 50, (1, 1), (u32::MAX, u32::MAX));
    assert!(ea > 0.05 && eb > 0.05 && (ea / eb).max(eb / ea) < 2.0, "equals split the work: {ea} {eb}");

    // Masks: A is on layer 1 and avoids layer 1 only; B is on layer 2 and avoids layer 1: B steers round A, A ignores B.
    let (ma, mb, _) = head_on_run(50, 50, (1, 2), (1, 1));
    assert!(ma < 1e-3 && mb > 0.05, "A ignores B's layer, B avoids A's: {ma} {mb}");
    let (na, nb, through) = head_on_run(50, 50, (1, 2), (2, 1)); // A avoids layer 2 (B), B avoids layer 1 (A): both avoid
    assert!(na > 0.05 && nb > 0.05 && through >= 0.85, "each avoids the other's layer: {na} {nb} {through}");
    let (za, zb, overlap) = head_on_run(50, 50, (1, 2), (4, 4)); // each avoids a layer nobody is on
    assert!(za < 1e-3 && zb < 1e-3, "neither steers around the other: {za} {zb}");
    assert!(overlap < 0.5, "they walked through each other: {overlap}");
}

#[test]
fn an_idle_agent_steps_aside_for_a_more_important_one() {
    // A corridor 2.8 m wide (about 1.4 m for an agent's centre after the erosion): a mover can't get a metre from an
    // idle agent in the middle (0.7 at most) unless the idle one moves over too.
    let walls = [(v3(0.0, 1.0, 6.4), v3(40.0, 2.0, 10.0)), (v3(0.0, 1.0, -6.4), v3(40.0, 2.0, 10.0))];
    let run = |hold: bool| {
        let mut sim = Sim::new(vec![floor_chunk(20.0, &walls)], walker_types(quick()));
        sim.runtime.idle_agents_hold_ground = hold;
        let idle = walker(&mut sim, v3(0.0, 0.0, 0.0), |d| d.avoidance_priority = Some(90));
        let mover = walker(&mut sim, v3(-10.0, 0.0, 0.05), |d| d.avoidance_priority = Some(10));
        ready(&mut sim, &[idle, mover]);
        let (mut asked, mut max_off, mut min_sep) = (false, 0.0f32, f32::MAX);
        for _ in 0..480 {
            sim.begin();
            sim.agents.steering[idle] = false; // idle: path follow turns steering off
            sim.agents.desired[idle] = Float3::default();
            sim.head_for(mover, v3(10.0, 0.0, 0.05), 0.3);
            sim.neighbor_grids_and_avoid();
            asked |= sim.agents.steering[idle];
            sim.integrate();
            max_off = max_off.max(sim.agents.position[idle].z.abs() + sim.agents.position[idle].x.abs());
            min_sep = min_sep.min(sim.distance(idle, mover));
        }
        (asked, max_off, min_sep, sim.agents.position[mover].x)
    };
    let (asked, off, sep, x) = run(false);
    assert!(asked, "the idle agent was asked to make way and steered");
    assert!(off > 0.2, "it stepped aside: {off}");
    assert!(sep >= 0.85, "and nobody was walked into: {sep}");
    assert!(x > 9.0, "the mover got through: {x}");

    let (asked, off, _, _) = run(true);
    assert!(!asked && off == 0.0, "holding ground: the idle agent never moves ({asked}, {off})");
}

#[test]
fn agents_go_round_a_static_obstacle_and_a_moving_one() {
    let mut sim = Sim::new(vec![floor_chunk(20.0, &[])], walker_types(quick()));
    let a = walker(&mut sim, v3(-12.0, 0.0, 0.1), |_| {});
    let b = walker(&mut sim, v3(12.0, 0.0, 15.0), |_| {});
    sim.add_obstacle(2.0, 2.0, 1, v3(0.0, 1.0, 0.0));
    let moving = sim.add_obstacle(1.0, 2.0, 1, v3(8.0, 1.0, 12.0));
    ready(&mut sim, &[a, b]);
    let (mut near_static, mut near_moving) = (f32::MAX, f32::MAX);
    for t in 0..480 {
        // The moving obstacle crosses b's way, +z to -z at 3 m/s along x = 8.
        sim.obstacles.position[moving.row()] = v3(8.0, 1.0, 12.0 - 3.0 * t as f32 * DT);
        sim.begin();
        sim.head_for(a, v3(12.0, 0.0, 0.1), 0.3);
        sim.head_for(b, v3(-12.0, 0.0, 15.0), 0.3);
        sim.neighbor_grids_and_avoid();
        sim.integrate();
        let pa = sim.agents.position[a];
        near_static = near_static.min(v3(pa.x, 0.0, pa.z).length());
        let pb = sim.agents.position[b];
        let om = sim.obstacles.position[moving.row()];
        near_moving = near_moving.min(((pb.x - om.x).powi(2) + (pb.z - om.z).powi(2)).sqrt());
    }
    assert!(near_static >= 2.5 - 0.15, "agent a kept out of the static cylinder (2 + 0.5): closest {near_static}");
    assert!(sim.agents.position[a].x > 11.0, "and got past it: {:?}", sim.agents.position[a]);
    assert!(near_moving >= 1.5 - 0.3, "agent b kept off the moving cylinder (1 + 0.5): closest {near_moving}");
    // An obstacle on a layer the agent doesn't avoid is walked through.
    let mut sim = Sim::new(vec![floor_chunk(20.0, &[])], walker_types(quick()));
    let c = walker(&mut sim, v3(-12.0, 0.0, 0.0), |d| d.avoid_layers = Some(2));
    sim.add_obstacle(2.0, 2.0, 1, v3(0.0, 1.0, 0.0));
    ready(&mut sim, &[c]);
    let mut closest = f32::MAX;
    for _ in 0..360 {
        sim.begin();
        sim.head_for(c, v3(12.0, 0.0, 0.0), 0.3);
        sim.neighbor_grids_and_avoid();
        sim.integrate();
        closest = closest.min(sim.agents.position[c].length());
    }
    assert!(closest < 0.5, "it walked straight through: {closest}");
}

#[test]
fn flight_separation_keeps_flyers_apart() {
    let flight = NavFlightAgent { radius: 1.0, speed: 6.0, separation_strength: 1.0, ..NavFlightAgent::default() };
    let types = AgentTypes::new(vec![AgentTypeSettings::flyer("Flyer", Hash128::new(9, 0, 0, 0), flight).with_avoidance(NavAvoidance::default())]);
    let mut sim = Sim::new(Vec::new(), types);
    let mut rng = Rng::new(3);
    let rows: Vec<usize> = (0..20)
        .map(|_| {
            let p = random_point(&mut rng, v3(-3.0, 20.0, -3.0), v3(3.0, 23.0, 3.0));
            let r = sim.add_agent(Hash128::new(9, 0, 0, 0), p, |_| {});
            sim.agents.steering[r] = true;
            r
        })
        .collect();
    let personal = flight.personal_radius();
    let spread = |sim: &Sim| {
        let mut m = f32::MAX;
        for (i, &a) in rows.iter().enumerate() {
            for &b in &rows[i + 1..] {
                m = m.min(sim.distance(a, b));
            }
        }
        m
    };
    let before = spread(&sim);
    assert!(before < 2.0 * personal, "they start overlapping: {before}");
    for _ in 0..900 {
        sim.begin();
        sim.neighbor_grids_and_avoid();
        sim.integrate();
    }
    let after = spread(&sim);
    assert!(after > 2.0 * personal - 0.05, "personal spaces ({personal} each) no longer overlap: {after}");

    // An idle flyer (steering off) isn't pushed itself, but the others keep off it.
    let idle = sim.add_agent(Hash128::new(9, 0, 0, 0), v3(0.0, 21.0, 0.0), |_| {});
    sim.agents.steering[idle] = false;
    let p0 = sim.agents.position[idle];
    for _ in 0..600 {
        sim.begin();
        sim.neighbor_grids_and_avoid();
        sim.integrate();
    }
    assert_eq!(sim.agents.position[idle], p0, "the idle flyer stays put");
    for &r in &rows {
        assert!(sim.distance(r, idle) > 2.0 * personal - 0.05, "{r} is off the idle flyer: {}", sim.distance(r, idle));
    }
}

#[test]
fn group_members_avoid_by_their_groups_priority_and_pass_through_their_own() {
    let types = walker_types(quick());
    let mut sim = Sim::new(vec![floor_chunk(20.0, &[])], types);
    // The group body: it carries no avoidance; members refer to it.
    let body_id = {
        let mut desc = AgentDesc::new(WALKER, v3(0.0, 0.0, 15.0));
        desc.group = Some(NavGroup { member_priority: 20, pass_through_each_other: true, ..NavGroup::default() });
        let id = sim.agents.reserve();
        sim.agents.activate(id, &desc, &sim.types).unwrap();
        id
    };
    let m1 = walker(&mut sim, v3(-10.0, 0.0, 0.0), |_| {});
    let m2 = walker(&mut sim, v3(10.0, 0.0, 0.0), |_| {});
    for (slot, &m) in [m1, m2].iter().enumerate() {
        sim.agents.data[m].group_member = Some(NavGroupMember { group: body_id, slot: slot as i32, enabled: true });
    }
    ready(&mut sim, &[m1, m2]);
    sim.neighbor_grids_and_avoid();
    let b1 = sim.avoid.ground_grid.try_get_body(m1 as i32).map(|k| sim.avoid.ground_grid.bodies[k]).unwrap();
    assert_eq!(b1.priority, 20, "a member avoids with its group's priority when more important than its own (50)");
    assert_eq!(b1.group, body_id.index() as i32 + 1);
    assert_eq!(b1.rank, 1);
    assert!(sim.avoid.ground_grid.try_get_body(body_id.row() as i32).is_none(), "the group body isn't a body");

    // Passing through each other: the two members of a ghost group go straight through.
    let mut min_sep = f32::MAX;
    for _ in 0..420 {
        sim.begin();
        sim.head_for(m1, v3(10.0, 0.0, 0.0), 0.3);
        sim.head_for(m2, v3(-10.0, 0.0, 0.0), 0.3);
        sim.neighbor_grids_and_avoid();
        sim.integrate();
        min_sep = min_sep.min(sim.distance(m1, m2));
    }
    assert!(min_sep < 0.3, "ghost members pass through each other: {min_sep}");
    assert!(sim.agents.position[m1].x > 9.0 && sim.agents.position[m2].x < -9.0);
}

#[test]
fn avoidance_is_deterministic() {
    let run = || {
        let mut sim = Sim::new(vec![floor_chunk(20.0, &[])], walker_types(quick()));
        let mut rng = Rng::new(5);
        let rows: Vec<usize> = (0..24)
            .map(|_| {
                let p = random_point(&mut rng, v3(-12.0, 0.0, -12.0), v3(12.0, 0.0, 12.0));
                walker(&mut sim, p, |_| {})
            })
            .collect();
        let goals: Vec<Float3> = rows.iter().map(|_| random_point(&mut rng, v3(-12.0, 0.0, -12.0), v3(12.0, 0.0, 12.0))).collect();
        ready(&mut sim, &rows);
        for _ in 0..300 {
            sim.begin();
            for (i, &r) in rows.iter().enumerate() {
                sim.head_for(r, goals[i], 0.3);
            }
            sim.neighbor_grids_and_avoid();
            sim.integrate();
        }
        rows.iter().map(|&r| sim.agents.position[r].to_array().map(f32::to_bits)).collect::<Vec<_>>()
    };
    assert_eq!(run(), run());
}
