//! The source hash rule (api-and-models §5), checked on a fixed fixture whose digest
//! `sourceHash.test.ts` checks too, so Rust and TypeScript agree.

#[path = "../source_hash.rs"]
mod source_hash;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use source_hash::{hashed_files, source_hash, to_hex};

/// The digest of the fixture (the same constant as FIXTURE_HASH in sourceHash.test.ts).
const FIXTURE_HASH: &str = "f8b235c550292bb3fef841a866a2801f";

/// The keys the fixture hashes, in order.
const EXPECTED_KEYS: [&str; 6] = [
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
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "myco-source-hash-{tag}-{}-{nanos}-{n}",
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

    /// The fixture from the spec: the hashed files, then the files that must be left out.
    /// With `eol_crlf` false, the `\r\n` of the spec's bytes become `\n` (the all-LF variant).
    fn populate(&self, eol_crlf: bool) {
        let fix = |s: &str| {
            if eol_crlf {
                s.to_string()
            } else {
                s.replace("\r\n", "\n")
            }
        };
        self.write("Cargo.toml", &fix("[workspace]\r\nmembers = [\"crates/*\"]\r\n"));
        self.write("rust-toolchain.toml", "[toolchain]\nchannel = \"1.99.1\"\n");
        self.write("Cargo.lock", "# lock\n");
        self.write("crates/a/Cargo.toml", "[package]\nname = \"a\"\n");
        self.write("crates/a/src/lib.rs", &fix("pub fn a() {}\r\n"));
        self.write("crates/b/src/lib.rs", "pub fn b() {}\n");
        // Left out: skipped directories at any depth, and other file types.
        self.write("crates/a/tests/t.rs", "fn t() {}\n");
        self.write("target/debug/x.rs", "fn x() {}\n");
        self.write("vectors/wire.rs", "fn w() {}\n");
        self.write("crates/a/README.md", "# a\n");
        self.write("build.mjs", "export {};\n");
    }

    fn keys(&self) -> Vec<String> {
        hashed_files(&self.root).into_iter().map(|(key, _)| key).collect()
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
    assert_eq!(keys, EXPECTED_KEYS);
    assert!(keys.windows(2).all(|w| w[0].as_bytes() < w[1].as_bytes()));
}

#[test]
fn to_hex_gives_32_lowercase_digits() {
    let bytes: [u8; 16] = [
        0x00, 0x01, 0x0f, 0x10, 0xab, 0xcd, 0xef, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66,
        0x77,
    ];
    let hex = to_hex(&bytes);
    assert_eq!(hex, "00010f10abcdefff0011223344556677");
    assert_eq!(hex.len(), 32);
    assert!(hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
}
