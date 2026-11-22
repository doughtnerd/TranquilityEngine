//! The source hash rule (`source_hash.rs`), checked on a fixed fixture whose digest
//! `src/plugins/animation/runtime/wasm/sourceHash.test.ts` checks too, so Rust and TypeScript agree.

#[path = "../source_hash.rs"]
mod source_hash;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use source_hash::{hashed_files, source_hash, to_hex};

/// The digest of the fixture (the same constant as FIXTURE_HASH in sourceHash.test.ts).
const FIXTURE_HASH: &str = "f48c3d629f8005b53ecb5f9bb68520ec";

/// The keys the fixture hashes, in order.
const EXPECTED_KEYS: [&str; 7] = [
    ".cargo/config.toml",
    "Cargo.lock",
    "Cargo.toml",
    "crates/a/Cargo.toml",
    "crates/a/src/lib.rs",
    "crates/b/src/lib.rs",
    "rust-toolchain.toml",
];

/// A fixture directory under the system temp dir, removed on drop (even when a test panics).
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "myco-anim-source-hash-{tag}-{}-{nanos}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        Fixture { root }
    }

    fn write(&self, rel: &str, contents: &str) {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    /// The hashed files, then the files that must be left out. With `eol_crlf` false, the `\r\n`
    /// become `\n` (the all-LF variant).
    fn populate(&self, eol_crlf: bool) {
        let fix = |s: &str| {
            if eol_crlf {
                s.to_string()
            } else {
                s.replace("\r\n", "\n")
            }
        };
        self.write(
            "Cargo.toml",
            &fix("[workspace]\r\nmembers = [\"crates/*\"]\r\n"),
        );
        self.write("rust-toolchain.toml", "[toolchain]\nchannel = \"1.99.1\"\n");
        self.write("Cargo.lock", "# lock\n");
        self.write(".cargo/config.toml", "[target.wasm32-unknown-unknown]\n");
        self.write("crates/a/Cargo.toml", "[package]\nname = \"a\"\n");
        self.write("crates/a/src/lib.rs", &fix("pub fn a() {}\r\n"));
        self.write("crates/b/src/lib.rs", "pub fn b() {}\n");
        // Left out: skipped directories at any depth, and other file types.
        self.write("crates/a/tests/t.rs", "fn t() {}\n");
        self.write("target/debug/x.rs", "fn x() {}\n");
        self.write("vectors/core.json", "{}\n");
        self.write("crates/a/README.md", "# a\n");
        self.write("build.mjs", "export {};\n");
    }

    fn keys(&self) -> Vec<String> {
        hashed_files(&self.root)
            .into_iter()
            .map(|(key, _)| key)
            .collect()
    }

    fn hash(&self) -> String {
        to_hex(&source_hash(&self.root))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn the_fixture_hashes_to_the_published_vector() {
    let fixture = Fixture::new("vector");
    fixture.populate(true);
    assert_eq!(fixture.hash(), FIXTURE_HASH);
}

#[test]
fn skipped_directories_and_other_files_are_left_out() {
    let fixture = Fixture::new("skipped");
    fixture.populate(true);
    assert_eq!(fixture.keys(), EXPECTED_KEYS);

    // Changing a left-out file leaves the hash alone.
    let before = fixture.hash();
    fixture.write("target/debug/x.rs", "fn changed() {}\n");
    fixture.write("crates/a/tests/t.rs", "fn changed() {}\n");
    fixture.write("crates/a/README.md", "changed\n");
    assert_eq!(fixture.hash(), before);

    // Changing a hashed file changes it.
    fixture.write(
        ".cargo/config.toml",
        "[target.wasm32-unknown-unknown]\nrustflags = []\n",
    );
    assert_ne!(fixture.hash(), before);
}

#[test]
fn crlf_and_lf_checkouts_hash_the_same() {
    let crlf = Fixture::new("crlf");
    crlf.populate(true);
    let lf = Fixture::new("lf");
    lf.populate(false);
    assert_eq!(crlf.hash(), lf.hash());
    assert_eq!(lf.hash(), FIXTURE_HASH);
}

#[test]
fn files_are_sorted_by_relative_key() {
    let fixture = Fixture::new("sorted");
    fixture.populate(true);
    let keys = fixture.keys();
    assert!(keys.windows(2).all(|w| w[0].as_bytes() < w[1].as_bytes()));
}
