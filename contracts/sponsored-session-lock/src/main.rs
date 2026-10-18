#![no_std]
#![no_main]

use ckb_std::{ckb_constants::Source, ckb_types::prelude::*, error::SysError, high_level::*};
use k256::ecdsa::{signature::hazmat::PrehashVerifier, Signature, VerifyingKey};

ckb_std::entry!(program_entry);
ckb_std::default_alloc!();

// Args: owner lock hash (32), session compressed pubkey (33), max fee (8), floor capacity (8).
// Data: remaining fee budget (8), position (8). All integers are unsigned little-endian.
// Witness lock: owner mode [0], or session mode [1, compact signature (64)].
fn number(bytes: &[u8]) -> Result<u64, i8> {
    Ok(u64::from_le_bytes(bytes.try_into().map_err(|_| 5)?))
}

// The app cell never loses capacity. Only the pinned pool lock can fund network fees.
fn sponsor_fee(expected: &[u8]) -> Result<u64, i8> {
    let input = load_cell(1, Source::Input).map_err(|_| 7)?;
    let output = load_cell(1, Source::Output).map_err(|_| 7)?;
    if input.lock() != output.lock() || input.type_().to_opt().is_some() || output.type_().to_opt().is_some()
        || load_cell_lock_hash(1, Source::Input).map_err(|_| 7)?.as_ref() != expected
        || !load_cell_data(1, Source::Input).map_err(|_| 7)?.is_empty()
        || !load_cell_data(1, Source::Output).map_err(|_| 7)?.is_empty() { return Err(7); }
    let before: u64 = input.capacity().unpack();
    let after: u64 = output.capacity().unpack();
    before.checked_sub(after).ok_or(9)
}

fn validate() -> Result<(), i8> {
    let script = load_script().map_err(|_| 5)?;
    let args = script.args().raw_data();
    if args.len() != 113 {
        return Err(5);
    }
    let witness = load_witness_args(0, Source::GroupInput).map_err(|_| 5)?;
    let lock = witness.lock().to_opt().ok_or(5)?.raw_data();
    if lock.as_ref() == [0] {
        // The other input's own lock validates owner authorization, for any wallet scheme.
        let mut i = 0;
        loop {
            match load_cell_lock_hash(i, Source::Input) {
                Ok(hash) if hash.as_ref() == &args[..32] => return Ok(()),
                Ok(_) => i += 1,
                Err(SysError::IndexOutOfBound) => return Err(6),
                Err(_) => return Err(5),
            }
        }
    }
    if lock.len() != 65 || lock[0] != 1 {
        return Err(6);
    }
    if load_input(2, Source::Input) != Err(SysError::IndexOutOfBound)
        || load_cell(2, Source::Output) != Err(SysError::IndexOutOfBound) { return Err(7); }
    let fee = sponsor_fee(&args[81..113])?;
    let input = load_cell(0, Source::Input).map_err(|_| 5)?;
    let output = load_cell(0, Source::Output).map_err(|_| 5)?;
    if input.type_().to_opt().is_some()
        || output.type_().to_opt().is_some()
        || input.lock() != script
        || output.lock() != script
    {
        return Err(7);
    }
    let before = load_cell_data(0, Source::Input).map_err(|_| 5)?;
    let after = load_cell_data(0, Source::Output).map_err(|_| 5)?;
    if before.len() != 16 || after.len() != 16 {
        return Err(5);
    }
    let position = number(&before[8..])?;
    if position.checked_add(1) != Some(number(&after[8..])?) {
        return Err(8);
    }
    let in_capacity: u64 = input.capacity().unpack();
    let out_capacity: u64 = output.capacity().unpack();
    let charge = number(&args[65..73])?;
    let budget = number(&before[..8])?;
    if in_capacity != out_capacity || fee == 0 || fee > charge || charge > budget
        || out_capacity < number(&args[73..81])? || number(&after[..8])? != budget - charge { return Err(9); }
    let public_key = VerifyingKey::from_sec1_bytes(&args[32..65]).map_err(|_| 6)?;
    let signature = Signature::from_slice(&lock[1..]).map_err(|_| 6)?;
    // This restricted policy has no witness-dependent effects. Raw tx hash commits all effects,
    // deps, network-specific session input, and output state. Never reuse for a generic lock.
    let message = load_tx_hash().map_err(|_| 5)?;
    public_key
        .verify_prehash(&message, &signature)
        .map_err(|_| 6)
}

pub fn program_entry() -> i8 {
    match validate() {
        Ok(()) => 0,
        Err(code) => code,
    }
}
