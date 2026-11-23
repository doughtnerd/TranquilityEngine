//! The rewrite behind [`crate::meter`]: append the fuel global, its two exports and their
//! functions, cap the memory, and insert the fuel checks into every body. Runs only on a module
//! [`crate::validate`] accepted (no imports, so appended items shift no index).

use alloc::borrow::Cow;
use alloc::vec::Vec;
use wasm_encoder::reencode::{Reencode, RoundtripReencoder};
use wasm_encoder::{
    BlockType, CodeSection, ConstExpr, CustomSection, ExportKind, ExportSection, Function,
    FunctionSection, GlobalSection, GlobalType, Instruction, MemorySection, Module, RawSection,
    TypeSection, ValType,
};
use wasmparser::{FuncType, FunctionBody, Payload};

use crate::cost::{dynamic, ends_block, weight, Dynamic};
use crate::{ModuleInfo, FUEL_GET, FUEL_SET, MARKER_SECTION, METER_VERSION};

type Error = wasm_encoder::reencode::Error;

// Section ids, and their order in a module (the tag section, 13, sits between memory and global;
// data count, 12, before code).
const TYPE: u8 = 1;
const FUNCTION: u8 = 3;
const GLOBAL: u8 = 6;
const EXPORT: u8 = 7;
const ORDER: [u8; 13] = [1, 2, 3, 4, 5, 13, 6, 7, 8, 9, 12, 10, 11];

fn rank(id: u8) -> usize {
    ORDER.iter().position(|&o| o == id).unwrap_or(usize::MAX)
}

/// What the rewrite appends, and the indices it appends them at.
struct Additions {
    /// The fuel global.
    fuel: u32,
    /// The types `(i64) -> ()` and `() -> i64`.
    set_ty: u32,
    /// The functions `myco_fuel_set` and `myco_fuel_get`.
    set_fn: u32,
}

/// Builds the output module while walking the input's sections in order.
struct Writer {
    module: Module,
    /// The sections the rewrite edits that the input has already shown (or that were synthesised).
    done: [bool; 4],
    add: Additions,
    types: Vec<FuncType>,
    func_types: Vec<u32>,
    memory_maximum: u32,
    code: CodeSection,
    bodies_left: u32,
}

const EDITED: [u8; 4] = [TYPE, FUNCTION, GLOBAL, EXPORT];

impl Writer {
    /// Emits empty-plus-appended versions of edited sections the input lacks and that come before
    /// a section of rank `before`.
    fn fill_missing(&mut self, before: usize) -> Result<(), Error> {
        for (slot, &id) in EDITED.iter().enumerate() {
            if !self.done[slot] && rank(id) < before {
                self.done[slot] = true;
                match id {
                    TYPE => self.module.section(&self.types_section(None)?),
                    FUNCTION => self.module.section(&self.function_section(None)?),
                    GLOBAL => self.module.section(&self.global_section(None)?),
                    _ => self.module.section(&self.export_section(None)?),
                };
            }
        }
        Ok(())
    }

    fn mark(&mut self, id: u8) {
        if let Some(slot) = EDITED.iter().position(|&e| e == id) {
            self.done[slot] = true;
        }
    }

    fn types_section(
        &self,
        input: Option<wasmparser::TypeSectionReader<'_>>,
    ) -> Result<TypeSection, Error> {
        let mut s = TypeSection::new();
        if let Some(r) = input {
            RoundtripReencoder.parse_type_section(&mut s, r)?;
        }
        s.ty().function([ValType::I64], []);
        s.ty().function([], [ValType::I64]);
        Ok(s)
    }

    fn function_section(
        &self,
        input: Option<wasmparser::FunctionSectionReader<'_>>,
    ) -> Result<FunctionSection, Error> {
        let mut s = FunctionSection::new();
        if let Some(r) = input {
            RoundtripReencoder.parse_function_section(&mut s, r)?;
        }
        s.function(self.add.set_ty);
        s.function(self.add.set_ty + 1);
        Ok(s)
    }

    fn global_section(
        &self,
        input: Option<wasmparser::GlobalSectionReader<'_>>,
    ) -> Result<GlobalSection, Error> {
        let mut s = GlobalSection::new();
        if let Some(r) = input {
            RoundtripReencoder.parse_global_section(&mut s, r)?;
        }
        s.global(
            GlobalType {
                val_type: ValType::I64,
                mutable: true,
                shared: false,
            },
            &ConstExpr::i64_const(0),
        );
        Ok(s)
    }

    fn export_section(
        &self,
        input: Option<wasmparser::ExportSectionReader<'_>>,
    ) -> Result<ExportSection, Error> {
        let mut s = ExportSection::new();
        if let Some(r) = input {
            RoundtripReencoder.parse_export_section(&mut s, r)?;
        }
        s.export(FUEL_SET, ExportKind::Func, self.add.set_fn);
        s.export(FUEL_GET, ExportKind::Func, self.add.set_fn + 1);
        Ok(s)
    }

    fn memory_section(
        &self,
        r: wasmparser::MemorySectionReader<'_>,
    ) -> Result<MemorySection, Error> {
        let mut s = MemorySection::new();
        for m in r {
            let mut ty = RoundtripReencoder.memory_type(m?)?;
            ty.maximum = Some(ty.maximum.unwrap_or(u64::from(self.memory_maximum)));
            s.memory(ty);
        }
        Ok(s)
    }

    /// Ends the code section: the two fuel functions, unmetered.
    fn finish_code(&mut self) {
        let mut set = Function::new([]);
        set.instruction(&Instruction::LocalGet(0));
        set.instruction(&Instruction::GlobalSet(self.add.fuel));
        set.instruction(&Instruction::End);
        self.code.function(&set);
        let mut get = Function::new([]);
        get.instruction(&Instruction::GlobalGet(self.add.fuel));
        get.instruction(&Instruction::End);
        self.code.function(&get);
        let code = core::mem::take(&mut self.code);
        self.module.section(&code);
    }

    fn body(&mut self, index: usize, body: FunctionBody<'_>) -> Result<(), Error> {
        let ty = &self.types[self.func_types[index] as usize];
        let mut locals = Vec::new();
        let mut local_count = ty.params().len() as u32;
        for l in body.get_locals_reader()? {
            let (n, t) = l?;
            local_count += n;
            locals.push((n, RoundtripReencoder.val_type(t)?));
        }
        let mut ops = Vec::new();
        let mut reader = body.get_operators_reader()?;
        while !reader.eof() {
            ops.push(reader.read()?);
        }
        let scratch = if ops.iter().any(|op| dynamic(op).is_some()) {
            locals.push((1, ValType::I32));
            Some(local_count)
        } else {
            None
        };

        // Metered blocks: (first op, static cost).
        let mut blocks = Vec::new();
        let (mut start, mut cost) = (0usize, 0u64);
        for (i, op) in ops.iter().enumerate() {
            cost += weight(op);
            if ends_block(op) {
                blocks.push((start, cost));
                start = i + 1;
                cost = 0;
            }
        }
        if cost > 0 {
            blocks.push((start, cost));
        }

        let fuel = self.add.fuel;
        let mut f = Function::new(locals);
        let mut next = blocks.iter().filter(|b| b.1 > 0).peekable();
        for (i, op) in ops.into_iter().enumerate() {
            if let Some(&(_, c)) = next.next_if(|b| b.0 == i) {
                charge(&mut f, fuel, |f| {
                    f.instruction(&Instruction::I64Const(c as i64));
                });
            }
            if let (Some(d), Some(s)) = (dynamic(&op), scratch) {
                f.instruction(&Instruction::LocalTee(s));
                charge(&mut f, fuel, |f| {
                    f.instruction(&Instruction::LocalGet(s));
                    f.instruction(&Instruction::I64ExtendI32U);
                    match d {
                        Dynamic::Shr(0) => {}
                        Dynamic::Shr(k) => {
                            f.instruction(&Instruction::I64Const(i64::from(k)));
                            f.instruction(&Instruction::I64ShrU);
                        }
                        Dynamic::Shl(k) => {
                            f.instruction(&Instruction::I64Const(i64::from(k)));
                            f.instruction(&Instruction::I64Shl);
                        }
                    }
                });
            }
            f.instruction(&RoundtripReencoder.instruction(op)?);
        }
        self.code.function(&f);
        Ok(())
    }
}

/// `fuel -= <amount>; if fuel < 0 { unreachable }`, stack-neutral; `amount` pushes one `i64`.
fn charge(f: &mut Function, fuel: u32, amount: impl FnOnce(&mut Function)) {
    f.instruction(&Instruction::GlobalGet(fuel));
    amount(f);
    f.instruction(&Instruction::I64Sub);
    f.instruction(&Instruction::GlobalSet(fuel));
    f.instruction(&Instruction::GlobalGet(fuel));
    f.instruction(&Instruction::I64Const(0));
    f.instruction(&Instruction::I64LtS);
    f.instruction(&Instruction::If(BlockType::Empty));
    f.instruction(&Instruction::Unreachable);
    f.instruction(&Instruction::End);
}

/// Count of items in sections the additions are indexed after.
fn counts(bytes: &[u8]) -> Result<(u32, u32), Error> {
    let (mut types, mut globals) = (0, 0);
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::TypeSection(r) => types = r.count(),
            Payload::GlobalSection(r) => globals = r.count(),
            _ => {}
        }
    }
    Ok((types, globals))
}

pub(crate) fn rewrite(bytes: &[u8], info: &ModuleInfo) -> Result<Vec<u8>, Error> {
    let (type_count, global_count) = counts(bytes)?;
    let mut w = Writer {
        module: Module::new(),
        done: [false; 4],
        add: Additions {
            fuel: global_count,
            set_ty: type_count,
            set_fn: info.functions,
        },
        types: Vec::new(),
        func_types: Vec::new(),
        memory_maximum: info.memory_maximum,
        code: CodeSection::new(),
        bodies_left: 0,
    };
    let mut body_index = 0usize;
    let mut name_sections = Vec::new();
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        let payload = payload?;
        if let Some((id, _)) = payload.as_section().filter(|(id, _)| *id != 0) {
            w.fill_missing(rank(id))?;
            w.mark(id);
        }
        match payload {
            Payload::TypeSection(r) => {
                for t in r.clone().into_iter_err_on_gc_types() {
                    w.types.push(t?);
                }
                let s = w.types_section(Some(r))?;
                w.module.section(&s);
            }
            Payload::FunctionSection(r) => {
                for t in r.clone() {
                    w.func_types.push(t?);
                }
                let s = w.function_section(Some(r))?;
                w.module.section(&s);
            }
            Payload::MemorySection(r) => {
                let s = w.memory_section(r)?;
                w.module.section(&s);
            }
            Payload::GlobalSection(r) => {
                let s = w.global_section(Some(r))?;
                w.module.section(&s);
            }
            Payload::ExportSection(r) => {
                let s = w.export_section(Some(r))?;
                w.module.section(&s);
            }
            Payload::CodeSectionStart { count, .. } => {
                w.bodies_left = count;
                if count == 0 {
                    w.finish_code();
                }
            }
            Payload::CodeSectionEntry(body) => {
                w.body(body_index, body)?;
                body_index += 1;
                w.bodies_left -= 1;
                if w.bodies_left == 0 {
                    w.finish_code();
                }
            }
            Payload::CustomSection(c) if c.name() == "name" => {
                name_sections.push(c.data());
            }
            Payload::CustomSection(_) | Payload::Version { .. } | Payload::End(_) => {}
            other => {
                if let Some((id, range)) = other.as_section() {
                    let data = &bytes[range.start as usize..range.end as usize];
                    w.module.section(&RawSection { id, data });
                }
            }
        }
    }
    w.fill_missing(usize::MAX)?;
    for data in name_sections {
        w.module.section(&CustomSection {
            name: Cow::Borrowed("name"),
            data: Cow::Borrowed(data),
        });
    }
    let marker = METER_VERSION.to_le_bytes();
    w.module.section(&CustomSection {
        name: Cow::Borrowed(MARKER_SECTION),
        data: Cow::Borrowed(&marker),
    });
    Ok(w.module.finish())
}
