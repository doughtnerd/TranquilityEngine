//! Static instruction weights (fuel units), version [`crate::METER_VERSION`].
//!
//! One unit is roughly one simple instruction. The weights only need to be deterministic and
//! rough proportions of real cost; they are part of the meter's version, so changing one changes
//! every module's consumption (bump [`crate::METER_VERSION`]).
//!
//! | instructions | weight |
//! |---|---|
//! | `block`, `loop`, `end`, `else`, `nop` (structure only) | 0 |
//! | everything else: constants, locals, globals, loads, stores, integer and float arithmetic, comparisons, conversions, `select`, `drop`, `br`, `br_if`, `if`, `return`, `unreachable`, reference and table get/set/size, `memory.size`, `data.drop`, `elem.drop` | 1 |
//! | `br_table` | 2 |
//! | integer `div`/`rem`; `f32`/`f64` `div` and `sqrt`; `call` | 4 |
//! | `call_indirect` | 8 |
//! | simd128 instructions | 2 |
//! | simd128 float `div` and `sqrt` | 8 |
//! | `memory.fill`, `memory.copy`, `memory.init` | 4, plus 1 per 16 bytes (dynamic) |
//! | `table.fill`, `table.copy`, `table.init`, `table.grow` | 4, plus 1 per element (dynamic) |
//! | `memory.grow` | 64, plus 4096 per page (dynamic: one unit per 16 bytes it zeroes) |
//!
//! The dynamic part is charged right before the instruction from its length operand (the `i32`
//! on top of the stack), so a bulk copy can't do unbounded work for a constant cost.

use wasmparser::Operator;

/// How an instruction's dynamic charge is computed from its `i32` length operand `n`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dynamic {
    /// `n >> shift`.
    Shr(u8),
    /// `n << shift`.
    Shl(u8),
}

macro_rules! define_is_simd {
    ($( @$proposal:ident $op:ident $({ $($arg:ident: $argty:ty),* })? => $visit:ident ($($ann:tt)*))*) => {
        /// Whether `op` is a simd128 instruction (the `0xFD` prefix).
        fn is_simd(op: &Operator<'_>) -> bool {
            #[allow(unreachable_patterns)]
            match op {
                $( Operator::$op $({ $($arg: _),* })? => define_is_simd!(@one $proposal), )*
                _ => false,
            }
        }
    };
    (@one simd) => { true };
    (@one $other:ident) => { false };
}
wasmparser::for_each_operator!(define_is_simd);

/// The static weight of `op`.
pub fn weight(op: &Operator<'_>) -> u64 {
    use Operator as O;
    match op {
        O::Block { .. } | O::Loop { .. } | O::End | O::Else | O::Nop => 0,
        O::BrTable { .. } => 2,
        O::I32DivS | O::I32DivU | O::I32RemS | O::I32RemU | O::I64DivS | O::I64DivU | O::I64RemS | O::I64RemU => 4,
        O::F32Div | O::F64Div | O::F32Sqrt | O::F64Sqrt => 4,
        O::Call { .. } => 4,
        O::CallIndirect { .. } => 8,
        O::MemoryFill { .. } | O::MemoryCopy { .. } | O::MemoryInit { .. } => 4,
        O::TableFill { .. } | O::TableCopy { .. } | O::TableInit { .. } | O::TableGrow { .. } => 4,
        O::MemoryGrow { .. } => 64,
        O::F32x4Div | O::F64x2Div | O::F32x4Sqrt | O::F64x2Sqrt => 8,
        op if is_simd(op) => 2,
        _ => 1,
    }
}

/// The dynamic charge of `op`, if it has one.
pub fn dynamic(op: &Operator<'_>) -> Option<Dynamic> {
    use Operator as O;
    match op {
        O::MemoryFill { .. } | O::MemoryCopy { .. } | O::MemoryInit { .. } => Some(Dynamic::Shr(4)),
        O::TableFill { .. } | O::TableCopy { .. } | O::TableInit { .. } | O::TableGrow { .. } => Some(Dynamic::Shr(0)),
        O::MemoryGrow { .. } => Some(Dynamic::Shl(12)),
        _ => None,
    }
}

/// Whether `op` ends a metered block: a branch, or a place a branch can land just after
/// (`loop` starts the block its back edges charge, `if`/`else` start their arms, `end` starts the
/// continuation that forward branches reach).
pub fn ends_block(op: &Operator<'_>) -> bool {
    use Operator as O;
    matches!(
        op,
        O::Loop { .. }
            | O::If { .. }
            | O::Else
            | O::End
            | O::Br { .. }
            | O::BrIf { .. }
            | O::BrTable { .. }
            | O::Return
            | O::Unreachable
    )
}
