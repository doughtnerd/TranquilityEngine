//! Navigation queries (ADR 0065), ported from Foxfire's `Runtime/Lib`: the search store shared by the
//! sliced searches, the query filter, nearest polygon, surface queries, walking A* with the
//! straight-path funnel across folds, a navmesh raycast (new; Foxfire has none), and flight-volume
//! queries and A*; and across chunks (W4): the loaded-chunk snapshot, seams and overlays, route graphs,
//! chunk and hybrid walk/fly routing, and flow fields.
pub mod chunks;
pub mod costs;
pub mod crossing;
pub mod filter;
pub mod flow;
pub mod hybrid;
pub mod index;
pub mod overlay;
pub mod pathfinding;
pub mod raycast;
pub mod route_graph;
pub mod route_search;
pub mod routing;
pub mod search;
pub mod seams;
pub mod straight_path;
pub mod surface;
pub mod volume;
