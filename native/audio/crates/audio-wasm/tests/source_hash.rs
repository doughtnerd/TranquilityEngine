//! The source hash rule (api-and-models §5), checked on a fixed fixture whose digest
//! `sourceHash.test.ts` checks too, so Rust and TypeScript agree.

#[path = "../source_hash.rs"]
mod source_hash;

#[test]
#[ignore = "A0.1-L2"]
fn the_fixture_hashes_to_the_published_vector() {
    todo!("A0.1-L2")
}

#[test]
#[ignore = "A0.1-L2"]
fn skipped_directories_and_other_files_are_left_out() {
    todo!("A0.1-L2")
}

#[test]
#[ignore = "A0.1-L2"]
fn crlf_and_lf_checkouts_hash_the_same() {
    todo!("A0.1-L2")
}

#[test]
#[ignore = "A0.1-L2"]
fn files_are_sorted_by_relative_key() {
    todo!("A0.1-L2")
}
