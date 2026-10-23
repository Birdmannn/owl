#![no_std]
#![no_main]
use blake2b_ref::Blake2bBuilder;
use ckb_std::{
    ckb_constants::Source,
    ckb_types::{bytes::Bytes, prelude::*},
    error::SysError,
    high_level::*,
};
use k256::ecdsa::{signature::hazmat::PrehashVerifier, Signature, VerifyingKey};
ckb_std::entry!(program_entry);
ckb_std::default_alloc!();
fn hash(bytes: &[u8]) -> [u8; 32] {
    let mut h = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    h.update(bytes);
    let mut out = [0; 32];
    h.finalize(&mut out);
    out
}
fn amount(bytes: &[u8]) -> Result<u64, i8> {
    Ok(u64::from_le_bytes(bytes.try_into().map_err(|_| 5)?))
}
// State: version(1), key(33), remaining(8), sequence(8), app-origin hash(32), policy count(1), policies(105 each).
// Policy: direction(0 input / 1 output), lock hash(32), type hash(32), data hash(32), max capacity(8).
// Zero data hash explicitly allows arbitrary data. Zero type hash means NO type (never a wildcard).
fn permits(state: &[u8], index: usize, source: Source, direction: u8) -> Result<bool, i8> {
    let lock = load_cell_lock_hash(index, source).map_err(|_| 5)?;
    let typ = load_cell_type_hash(index, source)
        .map_err(|_| 5)?
        .unwrap_or([0; 32]);
    let data = hash(&load_cell_data(index, source).map_err(|_| 5)?);
    let cap = load_cell_capacity(index, source).map_err(|_| 5)?;
    for p in state[83..].chunks_exact(105) {
        if p[0] == direction
            && p[1..33] == lock
            && p[33..65] == typ
            && (p[65..97] == [0; 32] || p[65..97] == data)
            && cap <= amount(&p[97..105])?
        {
            return Ok(true);
        }
    }
    Ok(false)
}
fn validate() -> Result<(), i8> {
    let script = load_script().map_err(|_| 5)?;
    let args = script.args().raw_data();
    // owner hash, pinned singleton TYPE_ID hash, pool hash, per-transaction max fee.
    if args.len() != 104 || args[..32] == args[64..96] {
        return Err(5);
    }
    let w = load_witness_args(0, Source::GroupInput).map_err(|_| 5)?;
    let lock = w.lock().to_opt().ok_or(5)?.raw_data();
    let mut ni = 0;
    let mut no = 0;
    let mut ti = 0u64;
    let mut to = 0u64;
    let mut own_in = 0u64;
    let mut own_out = 0u64;
    let mut si = None;
    let mut so = None;
    let mut first = None;
    let mut owner = false;
    loop {
        match load_cell_capacity(ni, Source::Input) {
            Ok(cap) => {
                ti = ti.checked_add(cap).ok_or(9)?;
                if load_cell_lock_hash(ni, Source::Input)
                    .map_err(|_| 5)?
                    .as_ref()
                    == &args[..32]
                {
                    owner = true;
                }
                if load_cell_lock(ni, Source::Input).map_err(|_| 5)? == script {
                    first = first.or(Some(ni));
                    own_in = own_in.checked_add(cap).ok_or(9)?;
                }
                if load_cell_type_hash(ni, Source::Input)
                    .map_err(|_| 5)?
                    .map(|h| h.as_ref() == &args[32..64])
                    .unwrap_or(false)
                {
                    if si.is_some() {
                        return Err(7);
                    }
                    si = Some(ni);
                }
                ni += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(5),
        }
    }
    // Independent passkey-owner recovery/update: the owner's separate lock verifies the exact transaction.
    if lock.as_ref() == [0] {
        return if owner { Ok(()) } else { Err(6) };
    }
    if lock.len() != 65 || lock[0] != 1 || ni < 2 {
        return Err(6);
    }
    loop {
        match load_cell_capacity(no, Source::Output) {
            Ok(cap) => {
                to = to.checked_add(cap).ok_or(9)?;
                if load_cell_lock(no, Source::Output).map_err(|_| 5)? == script {
                    own_out = own_out.checked_add(cap).ok_or(9)?;
                }
                if load_cell_type_hash(no, Source::Output)
                    .map_err(|_| 5)?
                    .map(|h| h.as_ref() == &args[32..64])
                    .unwrap_or(false)
                {
                    if so.is_some() {
                        return Err(7);
                    }
                    so = Some(no);
                }
                no += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(5),
        }
    }
    let si = si.ok_or(7)?;
    let so = so.ok_or(7)?;
    if load_cell_lock(si, Source::Input).map_err(|_| 5)? != script
        || load_cell_lock(so, Source::Output).map_err(|_| 5)? != script
    {
        return Err(7);
    }
    // Require the actual built-in TYPE_ID, not a user-selected script that permits duplicate authorities.
    let typ = load_cell_type(si, Source::Input).map_err(|_| 5)?.ok_or(7)?;
    let mut tid = [0u8; 32];
    tid[25..].copy_from_slice(b"TYPE_ID");
    if typ.code_hash().as_slice() != tid
        || typ.hash_type().as_slice() != [1]
        || typ.args().raw_data().len() != 32
    {
        return Err(7);
    }
    let state = load_cell_data(si, Source::Input).map_err(|_| 5)?;
    let next = load_cell_data(so, Source::Output).map_err(|_| 5)?;
    if state.len() < 83
        || state[0] != 1
        || state[82] == 0
        || state[82] > 16
        || state.len() != 83 + state[82] as usize * 105
        || next.len() != state.len()
    {
        return Err(7);
    }
    if state[..34] != next[..34]
        || state[50..] != next[50..]
        || amount(&next[42..50])? != amount(&state[42..50])?.checked_add(1).ok_or(9)?
    {
        return Err(7);
    }
    let spent = own_in.saturating_sub(own_out);
    if amount(&next[34..42])? != amount(&state[34..42])?.checked_sub(spent).ok_or(9)? {
        return Err(9);
    }
    let pi = ni - 1;
    let po = no.checked_sub(1).ok_or(7)?;
    if load_cell_lock_hash(pi, Source::Input)
        .map_err(|_| 5)?
        .as_ref()
        != &args[64..96]
        || load_cell_lock(pi, Source::Input).map_err(|_| 5)?
            != load_cell_lock(po, Source::Output).map_err(|_| 5)?
    {
        return Err(7);
    }
    for (count, source, last) in [(ni, Source::Input, pi), (no, Source::Output, po)] {
        for i in 0..count {
            let l = load_cell_lock_hash(i, source).map_err(|_| 5)?;
            if l.as_ref() == &args[64..96] {
                if i != last
                    || load_cell_type_hash(i, source).map_err(|_| 5)?.is_some()
                    || !load_cell_data(i, source).map_err(|_| 5)?.is_empty()
                {
                    return Err(7);
                }
                continue;
            }
            let own = load_cell_lock(i, source).map_err(|_| 5)? == script;
            let anchor = if source == Source::Input { si } else { so };
            if own && i == anchor {
                continue;
            }
            if own
                && load_cell_type_hash(i, source).map_err(|_| 5)?.is_none()
                && load_cell_data(i, source).map_err(|_| 5)?.is_empty()
            {
                continue;
            }
            // Other inputs enforce their own locks; all non-account outputs and all account asset inputs need explicit policies.
            if (source == Source::Output || own)
                && !permits(
                    &state,
                    i,
                    source,
                    if source == Source::Input { 0 } else { 1 },
                )?
            {
                return Err(8);
            }
        }
    }
    let fee = load_cell_capacity(pi, Source::Input)
        .map_err(|_| 5)?
        .checked_sub(load_cell_capacity(po, Source::Output).map_err(|_| 5)?)
        .ok_or(9)?;
    if fee == 0 || fee > amount(&args[96..104])? || ti.checked_sub(to) != Some(fee) {
        return Err(9);
    }
    let first = first.ok_or(5)?;
    let mut h = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    h.update(b"owl-pilot-wallet-session-v1");
    h.update(&load_tx_hash().map_err(|_| 5)?);
    let mut i = 0;
    loop {
        let raw = match load_witness(i, Source::Input) {
            Ok(w) => w,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(5),
        };
        let changed;
        let bytes = if i == first || i == pi {
            let original = load_witness_args(i, Source::Input).map_err(|_| 5)?;
            changed = original
                .as_builder()
                .lock(
                    Some(if i == first {
                        Bytes::from_static(&[1])
                    } else {
                        Bytes::new()
                    })
                    .pack(),
                )
                .build();
            changed.as_slice()
        } else {
            raw.as_slice()
        };
        h.update(&(bytes.len() as u64).to_le_bytes());
        h.update(bytes);
        i += 1;
    }
    let mut digest = [0; 32];
    h.finalize(&mut digest);
    let key = VerifyingKey::from_sec1_bytes(&state[1..34]).map_err(|_| 6)?;
    let sig = Signature::from_slice(&lock[1..]).map_err(|_| 6)?;
    key.verify_prehash(&digest, &sig).map_err(|_| 6)
}
pub fn program_entry() -> i8 {
    validate().map(|_| 0).unwrap_or_else(|e| e)
}
