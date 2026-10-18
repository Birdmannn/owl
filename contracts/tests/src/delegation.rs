use blake2b_ref::Blake2bBuilder;
use ckb_testtool::{builtin::ALWAYS_SUCCESS, ckb_types::{bytes::Bytes, core::{TransactionBuilder, TransactionView}, packed::*, prelude::*}, context::Context};
use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};

const CAPACITY: u64 = 400 * 100_000_000;
const FLOOR: u64 = 350 * 100_000_000;
fn key(n: u8) -> SigningKey { SigningKey::from_slice(&[n; 32]).unwrap() }
fn rule(id: u8, kind: u8, offset: u32, delta: u64) -> Vec<u8> { [vec![id; 32], vec![kind], offset.to_le_bytes().to_vec(), delta.to_le_bytes().to_vec()].concat() }
fn sign(tx: TransactionView, id: u8, signer: u8) -> TransactionView {
    let mut lock = vec![1]; lock.extend([id; 32]);
    let old = tx.witnesses().get(0).map(|w| WitnessArgs::from_slice(w.raw_data().as_ref()).unwrap()).unwrap_or_default();
    let unsigned = old.clone().as_builder().lock(Some(Bytes::from(lock.clone())).pack()).build();
    let mut witnesses: Vec<Bytes> = tx.witnesses().into_iter().map(|w| w.raw_data()).collect();
    if witnesses.is_empty() { witnesses.push(unsigned.as_bytes()); } else { witnesses[0] = unsigned.as_bytes(); }
    let mut digest = [0; 32];
    let mut hasher = Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    hasher.update(b"owl-pilot-delegation-v1"); hasher.update(tx.hash().as_slice());
    for witness in &witnesses { hasher.update(&(witness.len() as u64).to_le_bytes()); hasher.update(witness); }
    hasher.finalize(&mut digest);
    let sig: Signature = key(signer).sign_prehash(&digest).unwrap();
    lock.extend(sig.to_bytes());
    witnesses[0] = old.as_builder().lock(Some(Bytes::from(lock)).pack()).build().as_bytes();
    tx.as_advanced_builder().set_witnesses(witnesses.into_iter().map(|w| w.pack()).collect()).build()
}
struct Fixture { context: Context, tx: TransactionView, lock: Script, owner: Script }
fn fixture(selected: &[u8], typed: bool) -> Fixture {
    let mut context = Context::default();
    let code = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../build/pilot-delegation-lock")).unwrap();
    let dep = context.deploy_cell(code.into());
    let owner_dep = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let owner = context.build_script(&owner_dep, Bytes::new()).unwrap();
    let app_type = if typed { Some(context.build_script(&owner_dep, Bytes::from(vec![1])).unwrap()) } else { None };
    let type_hash = app_type.as_ref().map(|s| s.calc_script_hash().as_slice().to_vec()).unwrap_or(vec![0; 32]);
    let mut args = [owner.calc_script_hash().as_slice(), key(1).verifying_key().to_encoded_point(true).as_bytes(), &[3; 32], &type_hash,
        &1000u64.to_le_bytes(), &FLOOR.to_le_bytes(), &[selected.len() as u8]].concat();
    for &id in selected { args.extend(rule(id, if id == 2 { 1 } else { 0 }, 0, 1)); }
    let lock = context.build_script(&dep, args.into()).unwrap();
    let input = context.create_cell(CellOutput::new_builder().capacity(CAPACITY).lock(lock.clone()).type_(app_type.clone().pack()).build(),
        Bytes::from([5u64.to_le_bytes().to_vec(), vec![99; 4]].concat()));
    let tx = TransactionBuilder::default().input(CellInput::new_builder().previous_output(input).build())
        .output(CellOutput::new_builder().capacity(CAPACITY - 1000).lock(lock.clone()).type_(app_type.pack()).build())
        .output_data(Bytes::from([6u64.to_le_bytes().to_vec(), vec![99; 4]].concat())).build();
    let tx = context.complete_tx(tx);
    Fixture { context, tx, lock, owner }
}
fn verify(f: &Fixture, tx: &TransactionView) -> Result<u64, String> { f.context.verify_tx(tx, 100_000_000).map_err(|error| format!("{error:?}")) }
fn reject(f: &Fixture, tx: TransactionView, code: i8) { let error = verify(f, &tx).unwrap_err(); assert!(error.contains(&format!("error code {code}")) || error.contains(&format!("ValidationFailure({code})")), "{error}"); }

#[test] fn selected_increment_works_with_and_without_app_type() {
    for typed in [false, true] { let f = fixture(&[1], typed); println!("delegation cycles: {}", verify(&f, &sign(f.tx.clone(), 1, 1)).unwrap()); }
}
#[test] fn selected_decrement_works() {
    let f = fixture(&[1, 2], true);
    let tx = f.tx.as_advanced_builder().set_outputs_data(vec![Bytes::from([4u64.to_le_bytes().to_vec(), vec![99; 4]].concat()).pack()]).build();
    verify(&f, &sign(tx, 2, 1)).unwrap();
}
#[test] fn unselected_action_rejected_despite_valid_session_signature() { let f = fixture(&[1], false); reject(&f, sign(f.tx.clone(), 2, 1), 10); }
#[test] fn wrong_session_key_rejected() { let f = fixture(&[1], false); reject(&f, sign(f.tx.clone(), 1, 2), 6); }
#[test] fn wrong_transition_rejected() {
    let f = fixture(&[1], false);
    let tx = f.tx.as_advanced_builder().set_outputs_data(vec![Bytes::from([7u64.to_le_bytes().to_vec(), vec![99; 4]].concat()).pack()]).build();
    reject(&f, sign(tx, 1, 1), 8);
}
#[test] fn unrelated_state_bytes_cannot_change() {
    let f = fixture(&[1], false);
    let tx = f.tx.as_advanced_builder().set_outputs_data(vec![Bytes::from([6u64.to_le_bytes().to_vec(), vec![98; 4]].concat()).pack()]).build();
    reject(&f, sign(tx, 1, 1), 8);
}
#[test] fn fee_above_cap_rejected() {
    let f = fixture(&[1], false);
    let tx = f.tx.as_advanced_builder().set_outputs(vec![CellOutput::new_builder().capacity(CAPACITY - 1001).lock(f.lock.clone()).build()]).build();
    reject(&f, sign(tx, 1, 1), 9);
}
#[test] fn capacity_floor_cannot_be_spent() {
    let f = fixture(&[1], false);
    let tx = f.tx.as_advanced_builder().set_outputs(vec![CellOutput::new_builder().capacity(FLOOR - 1).lock(f.lock.clone()).build()]).build();
    reject(&f, sign(tx, 1, 1), 9);
}
#[test] fn app_type_cannot_be_removed() {
    let f = fixture(&[1], true);
    let tx = f.tx.as_advanced_builder().set_outputs(vec![CellOutput::new_builder().capacity(CAPACITY - 1000).lock(f.lock.clone()).build()]).build();
    reject(&f, sign(tx, 1, 1), 7);
}
#[test] fn extra_payment_rejected() {
    let f = fixture(&[1], false);
    let tx = f.tx.as_advanced_builder().output(CellOutput::new_builder().capacity(61 * 100_000_000).lock(f.owner.clone()).build()).output_data(Bytes::new()).build();
    reject(&f, sign(tx, 1, 1), 7);
}
#[test] fn type_witness_and_extra_witness_are_signed() {
    let f = fixture(&[1], true);
    let tx = f.tx.as_advanced_builder().witness(WitnessArgs::new_builder().input_type(Some(Bytes::from(vec![3])).pack()).build().as_bytes()).witness(Bytes::from(vec![4])).build();
    let signed = sign(tx, 1, 1);
    verify(&f, &signed).unwrap();
    let witness = WitnessArgs::from_slice(signed.witnesses().get(0).unwrap().raw_data().as_ref()).unwrap().as_builder().input_type(Some(Bytes::from(vec![5])).pack()).build();
    let changed = signed.as_advanced_builder().set_witnesses(vec![witness.as_bytes().pack(), Bytes::from(vec![4]).pack()]).build();
    reject(&f, changed, 6);
}
#[test] fn recovery_requires_owner_input() {
    let mut f = fixture(&[1], true);
    let witness = WitnessArgs::new_builder().lock(Some(Bytes::from(vec![0])).pack()).build();
    let tx = f.tx.as_advanced_builder().witness(witness.as_bytes()).build();
    reject(&f, tx.clone(), 6);
    let proof = f.context.create_cell(CellOutput::new_builder().capacity(CAPACITY).lock(f.owner.clone()).build(), Bytes::new());
    let output = tx.outputs().get(0).unwrap().as_builder().lock(f.owner.clone()).build();
    let tx = f.context.complete_tx(tx.as_advanced_builder().input(CellInput::new_builder().previous_output(proof).build()).set_outputs(vec![output]).build());
    verify(&f, &tx).unwrap();
}

// Threat-model regression: generic owner-input presence is safe only when that
// owner's lock requires authentication for EVERY spend. The SDK rejects
// permissionless/ACP owner locks before funding; the lock itself is unchanged.
#[test] fn permissionless_owner_input_is_not_a_signature_proof() {
    let mut f = fixture(&[1], false);
    let proof = f.context.create_cell(CellOutput::new_builder().capacity(CAPACITY).lock(f.owner.clone()).build(), Bytes::new());
    let attacker = f.owner.clone().as_builder().args(Bytes::from(vec![42]).pack()).build();
    let tx = f.context.complete_tx(f.tx.as_advanced_builder()
        .input(CellInput::new_builder().previous_output(proof).build())
        .set_outputs(vec![
            CellOutput::new_builder().capacity(CAPACITY - 1000).lock(attacker).build(),
            CellOutput::new_builder().capacity(CAPACITY).lock(f.owner.clone()).build(),
        ])
        .set_outputs_data(vec![Bytes::new().pack(), Bytes::new().pack()])
        .witness(WitnessArgs::new_builder().lock(Some(Bytes::from(vec![0])).pack()).build().as_bytes())
        .build());
    verify(&f, &tx).unwrap(); // No owner signature: ALWAYS_SUCCESS is intentionally unsafe here.
}
