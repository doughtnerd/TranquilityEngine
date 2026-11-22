//! The fuel pass through its interface: `validate`, `meter`, `is_metered`, and running original and
//! metered modules side by side in wasmi.

use anim_meter::{is_metered, meter, validate, Limits, MeterError, FUEL_GET, FUEL_SET, MARKER_SECTION, METER_VERSION};

/// The ABI's three small functions; tests add `myco_node_evaluate` and anything else.
const ABI: &str = r#"
  (func (export "myco_node_abi_version") (result i32) i32.const 1)
  (func (export "myco_node_describe") (result i32) i32.const 0)
  (func (export "myco_node_alloc") (param i32) (result i32) i32.const 0)
"#;
const MEMORY: &str = r#"(memory (export "memory") 1 16)"#;
const EVAL_SIG: &str = "(param $kind i32) (param $count i32) (param i32 i32 i32 i32 i32 i32) (param f32) (result i32)";

fn evaluate(body: &str) -> String {
    format!(r#"(func (export "myco_node_evaluate") {EVAL_SIG} {body})"#)
}

fn module(parts: &[&str]) -> Vec<u8> {
    let text = format!("(module {})", parts.join("\n"));
    wat::parse_str(&text).unwrap_or_else(|e| panic!("{e}\n{text}"))
}

/// A valid module whose evaluate returns 0.
fn minimal(extra: &str) -> Vec<u8> {
    module(&[MEMORY, ABI, &evaluate("i32.const 0"), extra])
}

/// Evaluate exercising every control construct: for i in 0..count, a `br_table` on `kind`, an
/// `if`/`else`, nested blocks with `br_if`, a `call` and a `call_indirect`; kind 9 fills `count`
/// bytes with `memory.fill`; kind 10 grows the memory by `count` pages.
const PROGRAM: &str = r#"
  (type $unary (func (param i32) (result i32)))
  (table 2 funcref)
  (elem (i32.const 0) $double $square)
  (func $double (type $unary) local.get 0 i32.const 1 i32.shl)
  (func $square (type $unary) local.get 0 local.get 0 i32.mul)
  (global $bias (mut i32) (i32.const 3))
  (func (export "myco_node_evaluate") (param $kind i32) (param $count i32) (param i32 i32 i32 i32 i32 i32) (param f32) (result i32)
    (local $i i32) (local $acc i32)
    (if (i32.eq (local.get $kind) (i32.const 9))
      (then (memory.fill (i32.const 0) (i32.const 7) (local.get $count)) (return (local.get $count))))
    (if (i32.eq (local.get $kind) (i32.const 10))
      (then (return (memory.grow (local.get $count)))))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
        (block $c2 (block $c1 (block $c0
          (br_table $c0 $c1 $c2 (i32.rem_u (i32.add (local.get $i) (local.get $kind)) (i32.const 3))))
          ;; case 0
          (local.set $acc (i32.add (local.get $acc) (call $double (local.get $i))))
          (br $c2))
          ;; case 1
          (local.set $acc (i32.add (local.get $acc)
            (call_indirect (type $unary) (local.get $i) (i32.and (local.get $i) (i32.const 1))))))
        ;; every case
        (if (i32.and (local.get $i) (i32.const 4))
          (then (local.set $acc (i32.xor (local.get $acc) (global.get $bias))))
          (else (global.set $bias (i32.add (global.get $bias) (i32.const 1)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (local.get $acc))
"#;

fn program() -> Vec<u8> {
    module(&[MEMORY, ABI, PROGRAM, r#"(@custom "producers" "x")"#])
}

type EvalArgs = (i32, i32, i32, i32, i32, i32, i32, i32, f32);

struct Instance {
    store: wasmi::Store<()>,
    instance: wasmi::Instance,
}

/// Runs `f` on a thread with a 64 MiB stack: wasmi's unoptimised (debug) executor needs more
/// than the test harness's default 2 MiB.
fn big_stack(f: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new().stack_size(64 << 20).spawn(f).unwrap().join().unwrap();
}

impl Instance {
    fn new(bytes: &[u8]) -> Self {
        let engine = wasmi::Engine::default();
        let module = wasmi::Module::new(&engine, bytes).unwrap();
        let mut store = wasmi::Store::new(&engine, ());
        let instance = wasmi::Linker::<()>::new(&engine).instantiate_and_start(&mut store, &module).unwrap();
        Self { store, instance }
    }

    fn eval(&mut self, kind: i32, count: i32) -> Result<i32, wasmi::Error> {
        let f = self.instance.get_typed_func::<EvalArgs, i32>(&self.store, "myco_node_evaluate").unwrap();
        f.call(&mut self.store, (kind, count, 0, 0, 0, 0, 0, 0, 0.0))
    }

    fn set_fuel(&mut self, fuel: i64) {
        let f = self.instance.get_typed_func::<i64, ()>(&self.store, FUEL_SET).unwrap();
        f.call(&mut self.store, fuel).unwrap();
    }

    fn fuel(&mut self) -> i64 {
        let f = self.instance.get_typed_func::<(), i64>(&self.store, FUEL_GET).unwrap();
        f.call(&mut self.store, ()).unwrap()
    }

    /// Runs with a large budget; returns the result and the fuel used.
    fn metered_eval(&mut self, kind: i32, count: i32) -> (i32, i64) {
        const BUDGET: i64 = 1 << 40;
        self.set_fuel(BUDGET);
        let r = self.eval(kind, count).unwrap();
        (r, BUDGET - self.fuel())
    }

    fn memory_pages(&self) -> (u64, Option<u64>) {
        let m = self.instance.get_memory(&self.store, "memory").unwrap();
        let ty = m.ty(&self.store);
        (m.size(&self.store), ty.maximum())
    }
}

fn limits() -> Limits {
    Limits::default()
}

#[test]
fn accepts_an_abi_module() {
    let info = validate(&program(), &limits()).unwrap();
    assert_eq!(info.functions, 6);
    assert_eq!((info.memory_initial, info.memory_maximum), (1, 16));
}

fn refused(bytes: &[u8]) -> MeterError {
    let e = validate(bytes, &limits()).unwrap_err();
    assert_eq!(meter(bytes, &limits()).unwrap_err(), e, "meter refuses what validate refuses");
    e
}

fn invalid(bytes: &[u8], needle: &str) {
    match refused(bytes) {
        MeterError::Invalid(m) => assert!(m.contains(needle), "{m:?} should mention {needle:?}"),
        e => panic!("expected Invalid, got {e:?}"),
    }
}

#[test]
fn refuses_imports_and_start_functions() {
    let import = module(&[r#"(import "env" "log" (func (param i32)))"#, MEMORY, ABI, &evaluate("i32.const 0")]);
    assert_eq!(refused(&import), MeterError::Import("env.log".into()));
    let mem = module(&[r#"(import "env" "mem" (memory 1))"#, r#"(export "memory" (memory 0))"#, ABI, &evaluate("i32.const 0")]);
    assert_eq!(refused(&mem), MeterError::Import("env.mem".into()));
    let start = minimal("(func $init) (start $init)");
    assert_eq!(refused(&start), MeterError::StartFunction);
}

#[test]
fn refuses_bad_memories() {
    assert_eq!(refused(&module(&[ABI, &evaluate("i32.const 0")])), MeterError::MemoryCount(0));
    assert_eq!(refused(&module(&["(memory 1)", ABI, &evaluate("i32.const 0")])), MeterError::MemoryNotExported);
    let renamed = module(&[r#"(memory (export "mem") 1)"#, ABI, &evaluate("i32.const 0")]);
    assert_eq!(refused(&renamed), MeterError::Export("mem".into()));
    let big_initial = module(&[r#"(memory (export "memory") 257)"#, ABI, &evaluate("i32.const 0")]);
    assert_eq!(refused(&big_initial), MeterError::MemoryTooLarge { pages: 257, limit: 256 });
    let big_max = module(&[r#"(memory (export "memory") 1 1000)"#, ABI, &evaluate("i32.const 0")]);
    assert_eq!(refused(&big_max), MeterError::MemoryTooLarge { pages: 1000, limit: 256 });
    let small = Limits { max_memory_pages: 8, ..Limits::default() };
    let e = validate(&program(), &small).unwrap_err();
    assert_eq!(e, MeterError::MemoryTooLarge { pages: 16, limit: 8 });
}

#[test]
fn refuses_exports_outside_the_abi() {
    assert_eq!(refused(&minimal(r#"(func (export "helper"))"#)), MeterError::Export("helper".into()));
    assert_eq!(refused(&minimal(r#"(table (export "t") 1 funcref)"#)), MeterError::Export("t".into()));
    let mutable = minimal(r#"(global (export "g") (mut i32) (i32.const 0))"#);
    assert_eq!(refused(&mutable), MeterError::Export("g".into()));
    let no_eval = module(&[MEMORY, ABI]);
    assert_eq!(refused(&no_eval), MeterError::MissingExport("myco_node_evaluate"));
    let wrong = module(&[MEMORY, ABI, r#"(func (export "myco_node_evaluate") (param i32) (result i32) i32.const 0)"#]);
    assert_eq!(refused(&wrong), MeterError::Signature("myco_node_evaluate"));
    let wrong_alloc = module(&[
        MEMORY,
        r#"(func (export "myco_node_abi_version") (result i32) i32.const 1)
           (func (export "myco_node_describe") (result i32) i32.const 0)
           (func (export "myco_node_alloc") (param i64) (result i32) i32.const 0)"#,
        &evaluate("i32.const 0"),
    ]);
    assert_eq!(refused(&wrong_alloc), MeterError::Signature("myco_node_alloc"));
}

#[test]
fn accepts_simd128_and_immutable_global_exports() {
    let simd = minimal(r#"(func (result i32) (i32x4.extract_lane 0 (i32x4.add (v128.const i32x4 1 2 3 4) (v128.const i32x4 5 6 7 8))))"#);
    meter(&simd, &limits()).unwrap();
    let globals = minimal(r#"(global (export "__heap_base") i32 (i32.const 1024)) (global (export "__data_end") i32 (i32.const 8))"#);
    meter(&globals, &limits()).unwrap();
}

#[test]
fn refuses_proposals_outside_the_allowed_set() {
    // Threads: shared memory and atomics.
    invalid(&module(&[r#"(memory (export "memory") 1 1 shared)"#, ABI, &evaluate("i32.const 0")]), "threads");
    // Relaxed SIMD (non-deterministic across machines).
    invalid(
        &minimal("(func (param v128 v128 v128) (result v128) (f32x4.relaxed_madd (local.get 0) (local.get 1) (local.get 2)))"),
        "relaxed SIMD",
    );
    // Multi-memory.
    invalid(&minimal("(memory 1)"), "multiple memories");
    // Memory64.
    invalid(&module(&[r#"(memory (export "memory") i64 1)"#, ABI, &evaluate("i32.const 0")]), "memory64");
    // Exception handling.
    invalid(&minimal("(tag $e) (func (throw $e))"), "exceptions");
    // Tail calls.
    invalid(&minimal("(func $f (return_call $f))"), "tail calls");
    // Not wasm at all.
    invalid(b"\0asm\x01\0\0\0\x05", "");
}

#[test]
fn refuses_oversized_modules() {
    let bytes = program();
    let tight = Limits { max_module_bytes: bytes.len() - 1, ..Limits::default() };
    assert_eq!(validate(&bytes, &tight).unwrap_err(), MeterError::TooLarge { bytes: bytes.len(), limit: bytes.len() - 1 });
}

#[test]
fn metered_modules_compute_the_same_results() {
    big_stack(metered_modules_compute_the_same_results_run);
}

fn metered_modules_compute_the_same_results_run() {
    let original = program();
    let metered = meter(&original, &limits()).unwrap();
    let mut a = Instance::new(&original);
    let mut b = Instance::new(&metered);
    for kind in 0..4 {
        for count in [0, 1, 2, 7, 33, 200] {
            let expected = a.eval(kind, count).unwrap();
            let (got, _) = b.metered_eval(kind, count);
            assert_eq!(got, expected, "kind {kind} count {count}");
        }
    }
    assert_eq!(a.eval(9, 100).unwrap(), b.metered_eval(9, 100).0);
}

#[test]
fn fuel_use_is_deterministic_and_grows_with_work() {
    big_stack(fuel_use_is_deterministic_and_grows_with_work_run);
}

fn fuel_use_is_deterministic_and_grows_with_work_run() {
    let metered = meter(&program(), &limits()).unwrap();
    let used = |kind, count| Instance::new(&metered).metered_eval(kind, count).1;
    let mut inst = Instance::new(&metered);
    for count in [0, 5, 50] {
        let first = used(0, count);
        assert!(first > 0);
        assert_eq!(used(0, count), first, "the same call costs the same in a fresh instance");
        assert_eq!(inst.metered_eval(0, count).1, first, "and again in the same instance");
    }
    // Each loop iteration pays: 3-periodic cases, so compare whole periods.
    let (c0, c3, c6) = (used(0, 0), used(0, 3), used(0, 6));
    assert!(c3 > c0);
    assert_eq!(c6 - c3, c3 - c0, "every 3 iterations cost the same");
}

#[test]
fn running_out_of_fuel_traps_exactly_at_the_budget() {
    big_stack(running_out_of_fuel_traps_exactly_at_the_budget_run);
}

fn running_out_of_fuel_traps_exactly_at_the_budget_run() {
    let metered = meter(&program(), &limits()).unwrap();
    let (expected, cost) = Instance::new(&metered).metered_eval(1, 40);

    // Fresh instances: evaluate changes a global the result depends on.
    let mut inst = Instance::new(&metered);
    inst.set_fuel(cost);
    assert_eq!(inst.eval(1, 40).unwrap(), expected, "a budget of exactly the cost suffices");
    assert_eq!(inst.fuel(), 0);

    let mut inst = Instance::new(&metered);
    inst.set_fuel(cost - 1);
    let err = inst.eval(1, 40).unwrap_err();
    assert_eq!(err.as_trap_code(), Some(wasmi::TrapCode::UnreachableCodeReached));
    assert!(inst.fuel() < 0, "a negative counter tells an exhausted budget from other traps");

    // A fresh instance starts with no fuel: nothing runs until the host sets a budget.
    let mut fresh = Instance::new(&metered);
    assert!(fresh.eval(0, 0).is_err());
    assert!(fresh.fuel() < 0);
}

#[test]
fn bulk_memory_and_growth_pay_for_their_length() {
    big_stack(bulk_memory_and_growth_pay_for_their_length_run);
}

fn bulk_memory_and_growth_pay_for_their_length_run() {
    let metered = meter(&program(), &limits()).unwrap();
    let used = |kind, count| Instance::new(&metered).metered_eval(kind, count).1;
    assert_eq!(used(9, 1600) - used(9, 0), 100, "memory.fill: one unit per 16 bytes");
    assert_eq!(used(10, 2) - used(10, 0), 2 * 4096, "memory.grow: 4096 per page");
    let mut inst = Instance::new(&metered);
    assert_eq!(inst.metered_eval(10, 2).0, 1, "grow returns the old size");
    // Growing past the maximum fails (returns -1) but still pays.
    assert_eq!(inst.metered_eval(10, 100).0, -1);
}

#[test]
fn memory_maximum_is_capped_at_the_limit() {
    big_stack(memory_maximum_is_capped_at_the_limit_run);
}

fn memory_maximum_is_capped_at_the_limit_run() {
    // Declared maximum kept.
    let mut kept = Instance::new(&meter(&program(), &limits()).unwrap());
    assert_eq!(kept.memory_pages(), (1, Some(16)));
    // No maximum: the limit becomes the maximum.
    let open = module(&[r#"(memory (export "memory") 2)"#, ABI, &evaluate("i32.const 0")]);
    assert_eq!(validate(&open, &limits()).unwrap().memory_maximum, 256);
    let small = Limits { max_memory_pages: 4, ..Limits::default() };
    let inst = Instance::new(&meter(&open, &small).unwrap());
    assert_eq!(inst.memory_pages(), (2, Some(4)));
    let _ = kept.metered_eval(0, 0);
}

#[test]
fn metering_is_deterministic_and_refuses_metered_input() {
    let original = program();
    let once = meter(&original, &limits()).unwrap();
    assert_eq!(meter(&original, &limits()).unwrap(), once, "same input, same bytes");
    assert!(!is_metered(&original));
    assert!(is_metered(&once));
    assert_eq!(validate(&once, &limits()).unwrap_err(), MeterError::AlreadyMetered);
    assert_eq!(meter(&once, &limits()).unwrap_err(), MeterError::AlreadyMetered);
    // A module that merely claims a fuel export is refused the same way.
    let claims = minimal(r#"(func (export "myco_fuel_set") (param i64))"#);
    assert_eq!(refused(&claims), MeterError::AlreadyMetered);

    // The marker carries the version; other custom sections are dropped, `name` is kept.
    let mut marker = None;
    let mut customs = Vec::new();
    for p in wasmparser::Parser::new(0).parse_all(&once) {
        if let wasmparser::Payload::CustomSection(c) = p.unwrap() {
            customs.push(c.name().to_string());
            if c.name() == MARKER_SECTION {
                marker = Some(c.data().to_vec());
            }
        }
    }
    assert_eq!(marker, Some(METER_VERSION.to_le_bytes().to_vec()));
    assert!(!customs.iter().any(|c| c == "producers"));
    let named = module(&[MEMORY, ABI, &evaluate("i32.const 0"), "(func $helper_name)"]);
    let named = meter(&named, &limits()).unwrap();
    assert!(wasmparser::Parser::new(0)
        .parse_all(&named)
        .any(|p| matches!(p, Ok(wasmparser::Payload::CustomSection(c)) if c.name() == "name")));
}

#[test]
fn a_module_without_globals_or_types_beyond_the_abi_meters() {
    big_stack(a_module_without_globals_or_types_beyond_the_abi_meters_run);
}

fn a_module_without_globals_or_types_beyond_the_abi_meters_run() {
    let bytes = minimal("");
    let metered = meter(&bytes, &limits()).unwrap();
    let mut inst = Instance::new(&metered);
    let (r, used) = inst.metered_eval(0, 0);
    assert_eq!((r, used), (0, 1), "one i32.const");
}
