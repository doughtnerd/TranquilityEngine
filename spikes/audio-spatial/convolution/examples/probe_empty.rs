// Baseline for the size probes: std + allocator only.
#[no_mangle]
pub extern "C" fn probe(n: u32) -> u32 {
    let v = vec![n as u8; n as usize + 1];
    v.iter().map(|x| *x as u32).sum()
}
