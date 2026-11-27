//! The source hash rule (`source_hash.rs`), checked on a fixed fixture whose digest
//! `src/engine/tween/wasm/sourceHash.test.ts` checks too, so Rust and TypeScript agree; and the
//! embedded hash against the tree.

#[path = "../source_hash.rs"]
mod source_hash;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use source_hash::{hashed_files, source_hash, to_hex};

/// The digest of the fixture (the same constant as FIXTURE_HASH in sourceHash.test.ts).
const FIXTURE_HASH: &str = "8823470c885e8f27144416f2587201de";

/// The keys the fixture hashes, in order.
const EXPECTED_KEYS: [&str; 7] = [
    "anim/Cargo.toml",
    "anim/crates/anim-math/src/lib.rs",
    "anim/crates/anim-wire/Cargo.toml",
    "common/curve/src/lib.rs",
    "tween/.cargo/config.toml",
    "tween/Cargo.lock",
    "tween/src/lib.rs",
];

/// A fixture base under the system temp dir, removed on drop (even when a test panics).
struct Fixture {
    base: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "myco-tween-source-hash-{tag}-{}-{nanos}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&base).unwrap();
        Fixture { base }
    }

    fn write(&self, rel: &str, contents: &str) {
        let path = self.base.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    /// The fixture: the hashed files, then files that must be left out. With `crlf` false the
    /// `\r\n` become `\n` (the all-LF variant).
    fn populate(&self, crlf: bool) {
        let fix = |s: &str| {
            if crlf {
                s.to_string()
            } else {
                s.replace("\r\n", "\n")
            }
        };
        self.write("tween/src/lib.rs", &fix("pub fn t() {}\r\n"));
        self.write("tween/Cargo.lock", "# lock\n");
        self.write(
            "tween/.cargo/config.toml",
            "[target.wasm32-unknown-unknown]\n",
        );
        self.write("common/curve/src/lib.rs", "pub fn c() {}\n");
        self.write("anim/Cargo.toml", &fix("[workspace]\r\n"));
        self.write("anim/crates/anim-math/src/lib.rs", "pub fn m() {}\n");
        self.write(
            "anim/crates/anim-wire/Cargo.toml",
            "[package]\nname = \"w\"\n",
        );
        // Left out: skipped directories, other file types, and what isn't hashed at all.
        self.write("tween/target/debug/x.rs", "fn x() {}\n");
        self.write("tween/pkg/y.rs", "fn y() {}\n");
        self.write("tween/tests/t.rs", "fn t() {}\n");
        self.write("tween/build.mjs", "export {};\n");
        self.write("anim/crates/anim-wire/vectors/v.rs", "fn v() {}\n");
        self.write("anim/crates/anim-wasm/src/lib.rs", "fn a() {}\n");
        self.write("anim/Cargo.lock", "# not hashed\n");
        self.write("audio/src/lib.rs", "fn a() {}\n");
    }

    fn keys(&self) -> Vec<String> {
        hashed_files(&self.base)
            .into_iter()
            .map(|(key, _)| key)
            .collect()
    }

    fn hash(&self) -> String {
        to_hex(&source_hash(&self.base))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn the_fixture_hashes_to_the_published_vector() {
    let fixture = Fixture::new("vector");
    fixture.populate(true);
    assert_eq!(fixture.keys(), EXPECTED_KEYS);
    assert_eq!(fixture.hash(), FIXTURE_HASH);
}

#[test]
fn crlf_and_lf_checkouts_hash_the_same() {
    let lf = Fixture::new("lf");
    lf.populate(false);
    assert_eq!(lf.hash(), FIXTURE_HASH);
}

#[test]
fn left_out_files_leave_the_hash_alone_and_hashed_ones_change_it() {
    let fixture = Fixture::new("change");
    fixture.populate(true);
    let before = fixture.hash();
    fixture.write("tween/target/debug/x.rs", "fn changed() {}\n");
    fixture.write("anim/crates/anim-wasm/src/lib.rs", "fn changed() {}\n");
    assert_eq!(fixture.hash(), before);
    fixture.write("common/curve/src/lib.rs", "pub fn changed() {}\n");
    assert_ne!(fixture.hash(), before);
}

#[test]
fn the_module_embeds_the_tree_hash() {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    assert_eq!(myco_tween_wasm::source_hash(), to_hex(&source_hash(&base)));
}
