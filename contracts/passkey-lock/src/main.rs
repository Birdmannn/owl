#![no_std]
#![no_main]
use alloc::string::String;
use base64ct::{Base64UrlUnpadded, Encoding};
use blake2b_ref::Blake2bBuilder;
use ckb_std::{
    ckb_constants::Source,
    ckb_types::{bytes::Bytes, prelude::*},
    error::SysError,
    high_level::*,
};
use p256::ecdsa::{signature::hazmat::PrehashVerifier, Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
ckb_std::entry!(program_entry);
ckb_std::default_alloc!();

#[derive(Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
    #[serde(rename = "crossOrigin", default)]
    cross_origin: bool,
}
fn validate() -> Result<(), i8> {
    // args: compressed P-256 public key, SHA256(rpId), SHA256(exact origin).
    let script = load_script().map_err(|_| 5)?;
    let args = script.args().raw_data();
    if args.len() != 97 {
        return Err(5);
    }
    let witness = load_witness_args(0, Source::GroupInput).map_err(|_| 5)?;
    let lock = witness.lock().to_opt().ok_or(5)?.raw_data();
    // version, optional sponsor input index (ffff = none), auth length, JSON length, compact signature, auth, JSON.
    if lock.len() < 71 || lock[0] != 0 {
        return Err(5);
    }
    let sponsor = u16::from_le_bytes(lock[1..3].try_into().map_err(|_| 5)?) as usize;
    let al = u16::from_le_bytes(lock[3..5].try_into().map_err(|_| 5)?) as usize;
    let jl = u16::from_le_bytes(lock[5..7].try_into().map_err(|_| 5)?) as usize;
    if al < 37 || al > 1024 || jl > 2048 || lock.len() != 71 + al + jl {
        return Err(5);
    }
    let auth = &lock[71..71 + al];
    let json = &lock[71 + al..];
    // User presence AND user verification are mandatory. Attested credential data is not an assertion.
    if &auth[..32] != &args[33..65] || auth[32] & 5 != 5 || auth[32] & 0x40 != 0 {
        return Err(6);
    }
    let data: ClientData = serde_json::from_slice(json).map_err(|_| 6)?;
    if data.kind != "webauthn.get"
        || data.cross_origin
        || Sha256::digest(data.origin.as_bytes())[..] != args[65..97]
    {
        return Err(6);
    }
    let mut first = None;
    let mut count = 0;
    loop {
        match load_cell_lock(count, Source::Input) {
            Ok(lock) => {
                if first.is_none() && lock == script {
                    first = Some(count);
                }
                count += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(5),
        }
    }
    let first = first.ok_or(5)?;
    if sponsor != 65535 && (sponsor != count - 1 || sponsor == first) {
        return Err(5);
    }
    let mut h = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    h.update(b"owl-pilot-passkey-v1");
    h.update(&load_tx_hash().map_err(|_| 5)?);
    let mut i = 0;
    loop {
        let raw = match load_witness(i, Source::Input) {
            Ok(w) => w,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(5),
        };
        let changed;
        let bytes = if i == first || i == sponsor {
            let original = load_witness_args(i, Source::Input).map_err(|_| 5)?;
            let replacement = if i == first {
                Bytes::copy_from_slice(&lock[..3])
            } else {
                Bytes::new()
            };
            changed = original.as_builder().lock(Some(replacement).pack()).build();
            changed.as_slice()
        } else {
            raw.as_slice()
        };
        h.update(&(bytes.len() as u64).to_le_bytes());
        h.update(bytes);
        i += 1;
    }
    let mut challenge = [0; 32];
    h.finalize(&mut challenge);
    if data.challenge != Base64UrlUnpadded::encode_string(&challenge) {
        return Err(6);
    }
    let mut signed = Sha256::new();
    signed.update(auth);
    signed.update(Sha256::digest(json));
    let key = VerifyingKey::from_sec1_bytes(&args[..33]).map_err(|_| 6)?;
    let sig = Signature::from_slice(&lock[7..71]).map_err(|_| 6)?;
    key.verify_prehash(&signed.finalize(), &sig).map_err(|_| 6)
}
pub fn program_entry() -> i8 {
    validate().map(|_| 0).unwrap_or_else(|e| e)
}
