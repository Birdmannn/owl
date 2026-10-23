#![no_std]
#![no_main]
use blake2b_ref::Blake2bBuilder;
use ckb_std::{ckb_constants::Source, ckb_types::{bytes::Bytes, prelude::*}, error::SysError, high_level::*};
use k256::ecdsa::{signature::hazmat::PrehashVerifier, Signature, VerifyingKey};
ckb_std::entry!(program_entry);
ckb_std::default_alloc!();

// v1 args: owner lock hash(32), account compressed key(33), pinned pool lock hash(32), max fee(8).
// The owner branch deliberately does not depend on a live Pilot service or account key.
fn validate() -> Result<(), i8> {
    let script = load_script().map_err(|_| 5)?;
    let args = script.args().raw_data();
    if args.len() != 105 || &args[..32] == &args[65..97] { return Err(5); }
    let witness = load_witness_args(0, Source::GroupInput).map_err(|_| 5)?;
    let lock = witness.lock().to_opt().ok_or(5)?.raw_data();
    if lock.as_ref() == [0] {
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
    if lock.len() != 65 || lock[0] != 1 { return Err(6); }
    let max_fee = u64::from_le_bytes(args[97..105].try_into().map_err(|_| 5)?);
    if max_fee == 0 { return Err(5); }
    let mut inputs = 0;
    let mut total_in = 0u64;
    let mut first = None;
    loop {
        match load_cell_capacity(inputs, Source::Input) {
            Ok(capacity) => {
                total_in = total_in.checked_add(capacity).ok_or(9)?;
                if first.is_none() && load_cell_lock(inputs, Source::Input).map_err(|_| 5)? == script { first = Some(inputs); }
                inputs += 1;
            },
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(5),
        }
    }
    let mut outputs = 0;
    let mut total_out = 0u64;
    loop {
        match load_cell_capacity(outputs, Source::Output) {
            Ok(capacity) => { total_out = total_out.checked_add(capacity).ok_or(9)?; outputs += 1; },
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(5),
        }
    }
    if inputs < 2 || outputs < 1 { return Err(7); }
    let pool_in = inputs - 1;
    let pool_out = outputs - 1;
    let before = load_cell(pool_in, Source::Input).map_err(|_| 7)?;
    let after = load_cell(pool_out, Source::Output).map_err(|_| 7)?;
    if load_cell_lock_hash(pool_in, Source::Input).map_err(|_| 7)?.as_ref() != &args[65..97]
        || before.lock() != after.lock() || before.type_().to_opt().is_some() || after.type_().to_opt().is_some()
        || !load_cell_data(pool_in, Source::Input).map_err(|_| 7)?.is_empty()
        || !load_cell_data(pool_out, Source::Output).map_err(|_| 7)?.is_empty() { return Err(7); }
    // Exactly one pool input and pool output: no ambiguous sponsor accounting.
    for i in 0..pool_in {
        if load_cell_lock_hash(i, Source::Input).map_err(|_| 7)?.as_ref() == &args[65..97] { return Err(7); }
    }
    for i in 0..pool_out {
        if load_cell_lock_hash(i, Source::Output).map_err(|_| 7)?.as_ref() == &args[65..97] { return Err(7); }
    }
    let before_capacity: u64 = before.capacity().unpack();
    let after_capacity: u64 = after.capacity().unpack();
    let fee = before_capacity.checked_sub(after_capacity).ok_or(9)?;
    if fee == 0 || fee > max_fee || total_in.checked_sub(total_out) != Some(fee) { return Err(9); }
    // Arbitrary outputs/type transitions are permitted; the CKB type scripts still validate them.
    // Bind all witnesses, omitting only this account signature and the pool signature.
    let mut hash = Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    hash.update(b"owl-pilot-account-v1"); hash.update(&load_tx_hash().map_err(|_| 5)?);
    let first = first.ok_or(5)?;
    let mut i = 0;
    loop {
        let bytes = match load_witness(i, Source::Input) {
            Ok(bytes) => bytes,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(5),
        };
        let modified;
        let bytes = if i == first || i == pool_in {
            let original = load_witness_args(i, Source::Input).map_err(|_| 5)?;
            let replacement = if i == first { Bytes::from_static(&[1]) } else { Bytes::new() };
            modified = original.as_builder().lock(Some(replacement).pack()).build(); modified.as_slice()
        } else { bytes.as_slice() };
        hash.update(&(bytes.len() as u64).to_le_bytes()); hash.update(bytes); i += 1;
    }
    let mut digest = [0; 32]; hash.finalize(&mut digest);
    let key = VerifyingKey::from_sec1_bytes(&args[32..65]).map_err(|_| 6)?;
    let signature = Signature::from_slice(&lock[1..]).map_err(|_| 6)?;
    key.verify_prehash(&digest, &signature).map_err(|_| 6)
}
pub fn program_entry() -> i8 { validate().map(|_| 0).unwrap_or_else(|e| e) }
