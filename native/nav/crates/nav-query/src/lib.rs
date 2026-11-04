//! Navigation queries (ADR 0065), ported from Foxfire's `Runtime/Lib`: the search store shared by the
//! sliced searches, the query filter, nearest polygon, surface queries, walking A* with the
//! straight-path funnel across folds, a navmesh raycast (new; Foxfire has none), and flight-volume
//! queries and A*.
pub mod filter;
pub mod index;
pub mod pathfinding;
pub mod raycast;
pub mod search;
pub mod straight_path;
pub mod surface;
pub mod volume;
