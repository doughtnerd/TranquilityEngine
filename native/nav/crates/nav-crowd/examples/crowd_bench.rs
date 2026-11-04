//! Crowd benchmark: ms per `Crowd::tick` for walkers (avoidance on) on a baked ~100 x 100 m floor with obstacles, and
//! for flyers in a flight volume over it. Run with `cargo run -p nav-crowd --example crowd_bench --release`.
//!
//! Each agent is sent to a random point (fixed seed) and sent again when it arrives, so the crowd keeps moving and
//! planning. The first second (searches filling, everyone starting) is reported apart from the steady state.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;

use bake_common::*;
use nav_crowd::agents::AgentDesc;
use nav_crowd::boundary::state_flags;
use nav_crowd::commands::Command;
use nav_crowd::ids::AgentId;
use nav_crowd::settings::{AgentTypeSettings, AgentTypes, CrowdSettings, NavAvoidance, NavFlightAgent, NavMeshAgent};
use nav_crowd::world::WorldInput;
use nav_crowd::{Crowd, NavPathState};
use nav_math::{Float3, Hash128};
use nav_query::chunks::LoadedChunk;
use std::sync::Arc;
use std::time::Instant;

const DT: f32 = 1.0 / 60.0;
const WALKER: Hash128 = Hash128::new(1, 0, 0, 0);
const FLYER: Hash128 = Hash128::new(100, 0, 0, 0);
const HALF: f32 = 50.0;

/// The floor, a 7 x 7 grid of 3 m boxes, baked for the walker and (with `fly`) the flyer.
fn bake(fly: bool) -> LoadedChunk {
    let t = Instant::now();
    let mut b = TestBake::new(Some(flat_profile()));
    b.add_floor((-HALF, -HALF), (HALF, HALF), 0.0, &[]);
    for i in 0..7 {
        for j in 0..7 {
            let (x, z) = (-36.0 + i as f32 * 12.0, -36.0 + j as f32 * 12.0);
            b.add_obstacle(v3(x, 1.5, z), v3(3.0, 3.0, 3.0), Rot::IDENTITY);
        }
    }
    if fly {
        b.add_flyer(flyer_with(1.0, 1.0, 0.0));
        b.set_chunk_bounds(v3(-HALF, -1.0, -HALF), v3(HALF, 12.0, HALF), 1, 3);
    }
    b.bake();
    eprintln!("baked {} in {:.0} ms", if fly { "floor + flight volume" } else { "floor" }, t.elapsed().as_secs_f64() * 1e3);
    LoadedChunk::new(Hash128::new(7, 7, 0, 0), Arc::new(b.out.file.clone()))
}

fn free(p: Float3) -> bool {
    // Off the boxes (with a margin for the agent radius).
    let near = |c: f32| ((c + 36.0) / 12.0).round() * 12.0 - 36.0;
    let (bx, bz) = (near(p.x), near(p.z));
    let in_grid = (-36.0..=36.0).contains(&bx) && (-36.0..=36.0).contains(&bz);
    !(in_grid && (p.x - bx).abs() < 2.5 && (p.z - bz).abs() < 2.5)
}

fn random_point(rng: &mut Rng, y: f32) -> Float3 {
    loop {
        let p = v3(rng.range(-HALF + 2.0, HALF - 2.0), y, rng.range(-HALF + 2.0, HALF - 2.0));
        if free(p) {
            return p;
        }
    }
}

struct Result {
    first_second: f64,
    steady: f64,
    worst: f64,
    arrivals: usize,
    failures: usize,
}

fn run(c: &mut Crowd, ids: &[AgentId], ty: Hash128, y: f32, ticks: usize, rng: &mut Rng) -> Result {
    let mut times = Vec::with_capacity(ticks);
    let mut t = 0.0f64;
    let mut arrivals = 0;
    let mut failures = 0;
    for _ in 0..ticks {
        t += DT as f64;
        let start = Instant::now();
        c.tick(DT, t, &WorldInput::default());
        times.push(start.elapsed().as_secs_f64() * 1e3);
        // Re-send the arrived (host work, not timed).
        for &id in ids {
            let Some(s) = c.agent_state(id) else { continue };
            if s.flags & state_flags::REQUEST_PENDING != 0 || c.queued().iter().any(|q| matches!(q, Command::SetDestination { agent, .. } if *agent == id)) {
                continue;
            }
            match s.path_state {
                NavPathState::Arrived => arrivals += 1,
                NavPathState::Failed => failures += 1,
                _ => continue,
            }
            let goal = random_point(rng, y);
            c.set_destination(id, goal);
        }
        let _ = ty;
    }
    let first: Vec<f64> = times[..60.min(ticks)].to_vec();
    let rest: Vec<f64> = times[60.min(ticks)..].to_vec();
    Result {
        first_second: first.iter().sum::<f64>() / first.len().max(1) as f64,
        steady: rest.iter().sum::<f64>() / rest.len().max(1) as f64,
        worst: times.iter().cloned().fold(0.0, f64::max),
        arrivals,
        failures,
    }
}

fn walkers(chunk: &LoadedChunk, n: usize, ticks: usize) {
    let walk = NavMeshAgent { radius: 0.5, height: 2.0, step_height: 0.5, pivot_offset: 0.0, max_snap_distance: 2.0, speed: 3.5, ..NavMeshAgent::default() };
    let types = AgentTypes::new(vec![AgentTypeSettings::walker("Walker", WALKER, walk).with_avoidance(NavAvoidance::default())]);
    let mut c = Crowd::new(CrowdSettings { agent_types: types, label: "bench".into(), ..CrowdSettings::default() });
    c.load_chunk(chunk.clone());
    let mut rng = Rng::new(17);
    let ids: Vec<AgentId> = (0..n)
        .map(|_| {
            let at = random_point(&mut rng, 0.0);
            let id = c.add_agent(AgentDesc::new(WALKER, at));
            let goal = random_point(&mut rng, 0.0);
            c.set_destination(id, goal);
            id
        })
        .collect();
    let r = run(&mut c, &ids, WALKER, 0.0, ticks, &mut rng);
    println!(
        "{n:>5} walkers: {:>7.3} ms/tick steady, {:>7.3} ms/tick first second, worst {:>7.2} ms ({} arrivals, {} failed, in {} ticks)",
        r.steady, r.first_second, r.worst, r.arrivals, r.failures, ticks
    );
}

fn flyers(chunk: &LoadedChunk, n: usize, ticks: usize) {
    // Foxfire's defaults are for big flyers (100 m arrival, 10 m waypoints): sized for a 1 m one here.
    let fly = NavFlightAgent { radius: 1.0, speed: 8.0, max_snap_distance: 2.0, waypoint_reached_distance: 1.0, arrival_distance: 1.0, off_path_distance: 5.0, ..NavFlightAgent::default() };
    let types = AgentTypes::new(vec![AgentTypeSettings::flyer("Flyer", FLYER, fly)]);
    let mut c = Crowd::new(CrowdSettings { agent_types: types, label: "bench".into(), ..CrowdSettings::default() });
    c.load_chunk(chunk.clone());
    let mut rng = Rng::new(23);
    let ids: Vec<AgentId> = (0..n)
        .map(|_| {
            let at = random_point(&mut rng, 6.0);
            let id = c.add_agent(AgentDesc::new(FLYER, at));
            let goal = random_point(&mut rng, 6.0);
            c.set_destination(id, goal);
            id
        })
        .collect();
    let r = run(&mut c, &ids, FLYER, 6.0, ticks, &mut rng);
    println!(
        "{n:>5} flyers:  {:>7.3} ms/tick steady, {:>7.3} ms/tick first second, worst {:>7.2} ms ({} arrivals, {} failed, in {} ticks)",
        r.steady, r.first_second, r.worst, r.arrivals, r.failures, ticks
    );
}

fn main() {
    let floor = bake(false);
    for (n, ticks) in [(100, 600), (1000, 600), (5000, 300)] {
        walkers(&floor, n, ticks);
    }
    let sky = bake(true);
    flyers(&sky, 500, 600);
}
