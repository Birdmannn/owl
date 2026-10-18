#![no_std]
#![no_main]

use blake2b_ref::Blake2bBuilder;
use ckb_std::{ckb_constants::Source, ckb_types::{bytes::Bytes, prelude::*}, error::SysError, high_level::*};
use k256::ecdsa::{signature::hazmat::PrehashVerifier, Signature, VerifyingKey};
ckb_std::entry!(program_entry);
ckb_std::default_alloc!();

fn u64_at(bytes: &[u8]) -> Result<u64, i8> {
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
    // owner(32), key(33), manifest(32), type hash(32), fee(8), floor(8), rule count(1).
    if args.len() < 146 { return Err(5); }
    let count = args[145] as usize;
    if count == 0 || count > 16 || args.len() != 178 + count * 45 { return Err(5); }
    for i in 0..count {
        let rule = &args[146 + i * 45..146 + (i + 1) * 45];
        if rule[32] > 1 || u64_at(&rule[37..45])? == 0 { return Err(5); }
        for j in 0..i {
            if rule[..32] == args[146 + j * 45..178 + j * 45] { return Err(5); }
        }
    }
    let witness = load_witness_args(0, Source::Input).map_err(|_| 5)?;
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
    if lock.len() != 97 || lock[0] != 1 { return Err(6); }
    if load_input(2, Source::Input) != Err(SysError::IndexOutOfBound)
        || load_cell(2, Source::Output) != Err(SysError::IndexOutOfBound) { return Err(7); }
    let input = load_cell(0, Source::Input).map_err(|_| 5)?;
    let output = load_cell(0, Source::Output).map_err(|_| 5)?;
    if input.lock() != script || output.lock() != script || input.type_() != output.type_() { return Err(7); }
    let expected_type = &args[97..129];
    match load_cell_type_hash(0, Source::Input).map_err(|_| 5)? {
        Some(hash) if hash.as_ref() == expected_type => (),
        None if expected_type == [0; 32] => (),
        _ => return Err(7),
    }
    let in_capacity: u64 = input.capacity().unpack();
    let out_capacity: u64 = output.capacity().unpack();
    let fee = sponsor_fee(&args[146 + count * 45..])?;
    if in_capacity != out_capacity { return Err(9); }
    if fee == 0 || fee > u64_at(&args[129..137])? || out_capacity < u64_at(&args[137..145])? { return Err(9); }
    let rule = (0..count).map(|i| &args[146 + i * 45..146 + (i + 1) * 45])
        .find(|rule| rule[..32] == lock[1..33]).ok_or(10)?;
    let before = load_cell_data(0, Source::Input).map_err(|_| 5)?;
    let after = load_cell_data(0, Source::Output).map_err(|_| 5)?;
    let offset = u32::from_le_bytes(rule[33..37].try_into().map_err(|_| 5)?) as usize;
    let end = offset.checked_add(8).ok_or(5)?;
    if before.len() != after.len() || end > before.len() || before[..offset] != after[..offset]
        || before[end..] != after[end..] { return Err(8); }
    let value = u64_at(&before[offset..end])?;
    let delta = u64_at(&rule[37..45])?;
    let expected = if rule[32] == 0 { value.checked_add(delta) } else { value.checked_sub(delta) };
    if expected != Some(u64_at(&after[offset..end])?) { return Err(8); }
    // Bind the operation and ALL witnesses, including type-script witnesses.
    // Only the signature itself is omitted; operation and witness fields remain committed.
    let mut hasher = Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    hasher.update(b"owl-pilot-delegation-sponsored-v1");
    hasher.update(&load_tx_hash().map_err(|_| 5)?);
    let unsigned = witness.as_builder().lock(Some(Bytes::copy_from_slice(&lock[..33])).pack()).build();
    let mut i = 0;
    loop {
        let bytes = match load_witness(i, Source::Input) {
            Ok(bytes) => bytes,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(5),
        };
        let pool;
        let bytes = if i == 0 { unsigned.as_slice() } else if i == 1 {
            pool = load_witness_args(1, Source::Input).map_err(|_| 5)?.as_builder()
                .lock(Some(Bytes::new()).pack()).build();
            pool.as_slice()
        } else { bytes.as_slice() };
        hasher.update(&(bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
        i += 1;
    }
    let mut digest = [0; 32];
    hasher.finalize(&mut digest);
    let key = VerifyingKey::from_sec1_bytes(&args[32..65]).map_err(|_| 6)?;
    let signature = Signature::from_slice(&lock[33..]).map_err(|_| 6)?;
    key.verify_prehash(&digest, &signature).map_err(|_| 6)
}
pub fn program_entry() -> i8 { validate().map(|_| 0).unwrap_or_else(|code| code) }
