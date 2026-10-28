use base64ct::{Base64UrlUnpadded, Encoding};
use blake2b_ref::Blake2bBuilder;
use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_types::{
        bytes::Bytes,
        core::{TransactionBuilder, TransactionView},
        packed::*,
        prelude::*,
    },
    context::Context,
};
use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
use p256::ecdsa::{Signature as PSignature, SigningKey as PKey};
use sha2::{Digest, Sha256};
const C: u64 = 100_000_000;
const ORIGIN: &str = "https://wallet.pilot.example";
fn hash(bytes: &[u8]) -> [u8; 32] {
    let mut h = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    h.update(bytes);
    let mut o = [0; 32];
    h.finalize(&mut o);
    o
}
fn sk(n: u8) -> SigningKey {
    SigningKey::from_slice(&[n; 32]).unwrap()
}
fn pk() -> PKey {
    PKey::from_slice(&[3; 32]).unwrap()
}
fn deploy(c: &mut Context, name: &str) -> OutPoint {
    c.deploy_cell(
        std::fs::read(format!("{}/../build/{name}", env!("CARGO_MANIFEST_DIR")))
            .unwrap()
            .into(),
    )
}
fn witnesses(tx: TransactionView, ws: Vec<Bytes>) -> TransactionView {
    tx.as_advanced_builder()
        .set_witnesses(ws.into_iter().map(|w| w.pack()).collect())
        .build()
}
fn replace_lock(tx: TransactionView, index: usize, lock: Vec<u8>) -> TransactionView {
    let mut ws: Vec<Bytes> = tx.witnesses().into_iter().map(|w| w.raw_data()).collect();
    while ws.len() <= index {
        ws.push(WitnessArgs::default().as_bytes());
    }
    ws[index] = WitnessArgs::from_slice(&ws[index])
        .unwrap()
        .as_builder()
        .lock(Some(Bytes::from(lock)).pack())
        .build()
        .as_bytes();
    witnesses(tx, ws)
}
fn digest(
    tx: &TransactionView,
    index: usize,
    sponsor: Option<usize>,
    domain: &[u8],
    placeholder: &[u8],
) -> [u8; 32] {
    let mut h = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    h.update(domain);
    h.update(tx.hash().as_slice());
    for (i, w) in tx.witnesses().into_iter().enumerate() {
        let raw = w.raw_data();
        let changed;
        let data = if i == index || sponsor == Some(i) {
            changed = WitnessArgs::from_slice(&raw)
                .unwrap()
                .as_builder()
                .lock(
                    Some(Bytes::copy_from_slice(if i == index {
                        placeholder
                    } else {
                        &[]
                    }))
                    .pack(),
                )
                .build();
            changed.as_slice()
        } else {
            raw.as_ref()
        };
        h.update(&(data.len() as u64).to_le_bytes());
        h.update(data);
    }
    let mut o = [0; 32];
    h.finalize(&mut o);
    o
}
fn passkey_sign(
    tx: TransactionView,
    index: usize,
    sponsor: Option<usize>,
    origin: &str,
    flags: u8,
    wrong_challenge: bool,
) -> TransactionView {
    passkey_sign_context(
        tx,
        index,
        sponsor,
        origin,
        flags,
        wrong_challenge,
        false,
        None,
    )
}
fn passkey_sign_context(
    tx: TransactionView,
    index: usize,
    sponsor: Option<usize>,
    origin: &str,
    flags: u8,
    wrong_challenge: bool,
    cross_origin: bool,
    top_origin: Option<&str>,
) -> TransactionView {
    let prefix = [
        vec![0],
        (sponsor.unwrap_or(65535) as u16).to_le_bytes().to_vec(),
    ]
    .concat();
    let challenge = digest(&tx, index, sponsor, b"owl-pilot-passkey-v1", &prefix);
    let mut data = serde_json::json!({"type":"webauthn.get","challenge":Base64UrlUnpadded::encode_string(if wrong_challenge{&[9;32]}else{&challenge}),"origin":origin,"crossOrigin":cross_origin});
    if let Some(top) = top_origin {
        data["topOrigin"] = serde_json::json!(top);
    }
    let json = data.to_string();
    let auth = [
        Sha256::digest(b"wallet.pilot.example").to_vec(),
        vec![flags],
        0u32.to_be_bytes().to_vec(),
    ]
    .concat();
    let signed = Sha256::digest([auth.clone(), Sha256::digest(json.as_bytes()).to_vec()].concat());
    let sig: PSignature = pk().sign_prehash(&signed).unwrap();
    let lock = [
        prefix,
        (auth.len() as u16).to_le_bytes().to_vec(),
        (json.len() as u16).to_le_bytes().to_vec(),
        sig.to_bytes().to_vec(),
        auth,
        json.into_bytes(),
    ]
    .concat();
    replace_lock(tx, index, lock)
}
fn owner(c: &mut Context) -> Script {
    let dep = deploy(c, "pilot-passkey-lock");
    c.build_script(
        &dep,
        [
            pk().verifying_key().to_encoded_point(true).as_bytes(),
            Sha256::digest(b"wallet.pilot.example").as_ref(),
            Sha256::digest(ORIGIN.as_bytes()).as_ref(),
        ]
        .concat()
        .into(),
    )
    .unwrap()
}
// testtool's complete_tx tries to resolve builtin TYPE_ID as a deployed binary.
// Resolve lock dependencies with types temporarily omitted; the verifier still executes the original real TYPE_ID.
fn complete(c: &mut Context, tx: TransactionView) -> TransactionView {
    let mut saved = Vec::new();
    for input in tx.inputs().into_iter() {
        let point = input.previous_output();
        let (cell, data) = c.get_cell(&point).unwrap();
        if cell.type_().to_opt().is_some() {
            saved.push((point.clone(), cell.clone(), data.clone()));
            c.create_cell_with_out_point(
                point,
                cell.as_builder().type_(None::<Script>.pack()).build(),
                data,
            );
        }
    }
    let outputs = tx
        .outputs()
        .into_iter()
        .map(|o| o.as_builder().type_(None::<Script>.pack()).build())
        .collect();
    let partial = c.complete_tx(tx.as_advanced_builder().set_outputs(outputs).build());
    for (point, cell, data) in saved {
        c.create_cell_with_out_point(point, cell, data);
    }
    tx.as_advanced_builder()
        .set_cell_deps(partial.cell_deps().into_iter().collect())
        .build()
}
fn verify(c: &Context, tx: &TransactionView) -> Result<u64, String> {
    c.verify_tx(tx, 200_000_000).map_err(|e| format!("{e:?}"))
}
fn root_fixture() -> (Context, TransactionView) {
    let mut c = Context::default();
    let root = owner(&mut c);
    let d = c.deploy_cell(ALWAYS_SUCCESS.clone());
    let pool = c.build_script(&d, Bytes::from(vec![1])).unwrap();
    let a = c.create_cell(
        CellOutput::new_builder()
            .capacity(1000 * C)
            .lock(root.clone())
            .build(),
        Bytes::new(),
    );
    let b = c.create_cell(
        CellOutput::new_builder()
            .capacity(1000 * C)
            .lock(pool.clone())
            .build(),
        Bytes::new(),
    );
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(a).build())
        .input(CellInput::new_builder().previous_output(b).build())
        .output(
            CellOutput::new_builder()
                .capacity(1000 * C)
                .lock(root)
                .build(),
        )
        .output_data(Bytes::new())
        .output(
            CellOutput::new_builder()
                .capacity(1000 * C - 500)
                .lock(pool)
                .build(),
        )
        .output_data(Bytes::new())
        .witness(WitnessArgs::default().as_bytes())
        .witness(WitnessArgs::default().as_bytes())
        .build();
    let tx = complete(&mut c, tx);
    (c, tx)
}
#[test]
fn passkey_owner_authenticates_real_es256_webauthn() {
    let (c, tx) = root_fixture();
    let cycles = verify(&c, &passkey_sign(tx, 0, Some(1), ORIGIN, 5, false)).unwrap();
    println!("passkey cycles: {cycles}");
}
#[test]
fn passkey_rejects_wrong_origin_challenge_and_missing_uv() {
    let (c, tx) = root_fixture();
    for (origin, flags, bad) in [
        ("https://evil.example", 5, false),
        (ORIGIN, 1, false),
        (ORIGIN, 5, true),
    ] {
        assert!(verify(
            &c,
            &passkey_sign(tx.clone(), 0, Some(1), origin, flags, bad)
        )
        .is_err());
    }
}
#[test]
fn passkey_binds_payment_and_type_witnesses() {
    let (c, tx) = root_fixture();
    let signed = passkey_sign(tx, 0, Some(1), ORIGIN, 5, false);
    let changed = signed
        .as_advanced_builder()
        .set_outputs_data(vec![Bytes::from(vec![1]).pack(), Bytes::new().pack()])
        .build();
    assert!(verify(&c, &changed).is_err());
    let mut ws: Vec<Bytes> = signed
        .witnesses()
        .into_iter()
        .map(|w| w.raw_data())
        .collect();
    ws[1] = WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(vec![1])).pack())
        .build()
        .as_bytes();
    assert!(verify(&c, &witnesses(signed, ws)).is_err());
}
#[test]
fn passkey_rejects_malformed_packet_without_panic() {
    let (c, tx) = root_fixture();
    for bytes in [vec![], vec![0; 70], vec![0; 200], vec![255; 100]] {
        assert!(verify(&c, &replace_lock(tx.clone(), 0, bytes)).is_err());
    }
}
struct F {
    c: Context,
    tx: TransactionView,
    account: Script,
    root: Script,
    state: Vec<u8>,
}
fn state(key: u8, remaining: u64, sequence: u64, recipient: &Script) -> Vec<u8> {
    [
        vec![1],
        sk(key)
            .verifying_key()
            .to_encoded_point(true)
            .as_bytes()
            .to_vec(),
        remaining.to_le_bytes().to_vec(),
        sequence.to_le_bytes().to_vec(),
        hash(ORIGIN.as_bytes()).to_vec(),
        vec![1],
        vec![1],
        recipient.calc_script_hash().as_slice().to_vec(),
        vec![0; 32],
        hash(&[]).to_vec(),
        (61 * C).to_le_bytes().to_vec(),
    ]
    .concat()
}
fn fixture() -> F {
    fixture_mode(false)
}
fn fixture_mode(general: bool) -> F {
    let mut c = Context::default();
    let root = owner(&mut c);
    let dep = deploy(
        &mut c,
        if general {
            "pilot-wallet-general-lock"
        } else {
            "pilot-wallet-session-lock"
        },
    );
    let d = c.deploy_cell(ALWAYS_SUCCESS.clone());
    let recipient = c.build_script(&d, Bytes::from(vec![1])).unwrap();
    let pool = c.build_script(&d, Bytes::from(vec![2])).unwrap();
    let mut tid = [0u8; 32];
    tid[25..].copy_from_slice(b"TYPE_ID");
    let typ = Script::new_builder()
        .code_hash(tid.pack())
        .hash_type(1u8)
        .args(Bytes::from(vec![7; 32]).pack())
        .build();
    let account = c
        .build_script(
            &dep,
            [
                root.calc_script_hash().as_slice(),
                typ.calc_script_hash().as_slice(),
                pool.calc_script_hash().as_slice(),
                &1000u64.to_le_bytes(),
            ]
            .concat()
            .into(),
        )
        .unwrap();
    let mut initial = state(1, 100 * C, 0, &recipient);
    let mut next = state(1, 39 * C, 1, &recipient);
    if general {
        initial[0] = 2;
        next[0] = 2;
    }
    let input = c.create_cell(
        CellOutput::new_builder()
            .capacity(1000 * C)
            .lock(account.clone())
            .type_(Some(typ.clone()).pack())
            .build(),
        initial.clone().into(),
    );
    let sponsor = c.create_cell(
        CellOutput::new_builder()
            .capacity(1000 * C)
            .lock(pool.clone())
            .build(),
        Bytes::new(),
    );
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(input).build())
        .input(CellInput::new_builder().previous_output(sponsor).build())
        .output(
            CellOutput::new_builder()
                .capacity(939 * C)
                .lock(account.clone())
                .type_(Some(typ).pack())
                .build(),
        )
        .output_data(Bytes::from(next))
        .output(
            CellOutput::new_builder()
                .capacity(61 * C)
                .lock(recipient)
                .build(),
        )
        .output_data(Bytes::new())
        .output(
            CellOutput::new_builder()
                .capacity(1000 * C - 500)
                .lock(pool)
                .build(),
        )
        .output_data(Bytes::new())
        .witness(WitnessArgs::default().as_bytes())
        .witness(WitnessArgs::default().as_bytes())
        .build();
    let tx = complete(&mut c, tx);
    F {
        c,
        tx,
        account,
        root,
        state: initial,
    }
}
fn session_sign(tx: TransactionView, key: u8, index: usize) -> TransactionView {
    let h = digest(
        &tx,
        index,
        Some(tx.inputs().len() - 1),
        b"owl-pilot-wallet-session-v1",
        &[1],
    );
    let sig: Signature = sk(key).sign_prehash(&h).unwrap();
    replace_lock(tx, index, [vec![1], sig.to_bytes().to_vec()].concat())
}
#[test]
fn session_enforces_real_typeid_and_cumulative_budget() {
    let f = fixture();
    verify(&f.c, &session_sign(f.tx.clone(), 1, 0)).unwrap();
}
#[test]
fn session_cannot_raise_budget_or_change_policy_key_or_app() {
    let f = fixture();
    for range in [1..2, 34..35, 42..43, 50..51, 83..84] {
        let mut data = f.tx.outputs_data().get(0).unwrap().raw_data().to_vec();
        data[range.start] ^= 1;
        let tx =
            f.tx.as_advanced_builder()
                .set_outputs_data(vec![
                    Bytes::from(data).pack(),
                    Bytes::new().pack(),
                    Bytes::new().pack(),
                ])
                .build();
        assert!(verify(&f.c, &session_sign(tx, 1, 0)).is_err());
    }
}
#[test]
fn session_rejects_unapproved_recipient_data_and_amount() {
    let f = fixture();
    let wrong =
        f.tx.outputs()
            .get(1)
            .unwrap()
            .as_builder()
            .lock(f.root.clone())
            .build();
    let tx =
        f.tx.as_advanced_builder()
            .set_outputs(vec![
                f.tx.outputs().get(0).unwrap(),
                wrong,
                f.tx.outputs().get(2).unwrap(),
            ])
            .build();
    assert!(verify(&f.c, &session_sign(tx, 1, 0)).is_err());
    let tx =
        f.tx.as_advanced_builder()
            .set_outputs_data(vec![
                f.tx.outputs_data().get(0).unwrap(),
                Bytes::from(vec![1]).pack(),
                Bytes::new().pack(),
            ])
            .build();
    assert!(verify(&f.c, &session_sign(tx, 1, 0)).is_err());
    let tx =
        f.tx.as_advanced_builder()
            .set_outputs(vec![
                f.tx.outputs().get(0).unwrap(),
                f.tx.outputs()
                    .get(1)
                    .unwrap()
                    .as_builder()
                    .capacity(62 * C)
                    .build(),
                f.tx.outputs()
                    .get(2)
                    .unwrap()
                    .as_builder()
                    .capacity(999 * C - 500)
                    .build(),
            ])
            .build();
    assert!(verify(&f.c, &session_sign(tx, 1, 0)).is_err());
}
#[test]
fn session_cannot_remove_authority_or_restore_spent_budget() {
    let f = fixture();
    let tx =
        f.tx.as_advanced_builder()
            .set_outputs(vec![
                f.tx.outputs()
                    .get(0)
                    .unwrap()
                    .as_builder()
                    .type_(None::<Script>.pack())
                    .build(),
                f.tx.outputs().get(1).unwrap(),
                f.tx.outputs().get(2).unwrap(),
            ])
            .build();
    assert!(verify(&f.c, &session_sign(tx, 1, 0)).is_err());
    let tx =
        f.tx.as_advanced_builder()
            .set_outputs_data(vec![
                Bytes::from(f.state.clone()).pack(),
                Bytes::new().pack(),
                Bytes::new().pack(),
            ])
            .build();
    assert!(verify(&f.c, &session_sign(tx, 1, 0)).is_err());
}
#[test]
fn revoked_session_key_cannot_sign_a_rotated_authority() {
    let mut f = fixture();
    let mut input =
        f.c.get_cell(&f.tx.inputs().get(0).unwrap().previous_output())
            .unwrap();
    let mut data = input.1.to_vec();
    data[1..34].copy_from_slice(sk(2).verifying_key().to_encoded_point(true).as_bytes());
    input.1 = Bytes::from(data.clone());
    let out = f.c.create_cell(input.0, input.1);
    let mut next = f.tx.outputs_data().get(0).unwrap().raw_data().to_vec();
    next[1..34].copy_from_slice(&data[1..34]);
    let tx =
        f.tx.as_advanced_builder()
            .set_inputs(vec![
                CellInput::new_builder().previous_output(out).build(),
                f.tx.inputs().get(1).unwrap(),
            ])
            .set_outputs_data(vec![
                Bytes::from(next).pack(),
                Bytes::new().pack(),
                Bytes::new().pack(),
            ])
            .build();
    assert!(verify(&f.c, &session_sign(tx.clone(), 1, 0)).is_err());
    verify(&f.c, &session_sign(tx, 2, 0)).unwrap();
}
#[test]
fn session_key_cannot_spend_without_state_even_with_valid_signature() {
    let mut f = fixture();
    let point = f.c.create_cell(
        CellOutput::new_builder()
            .capacity(1000 * C)
            .lock(f.account.clone())
            .build(),
        Bytes::new(),
    );
    let tx =
        f.tx.as_advanced_builder()
            .set_inputs(vec![
                CellInput::new_builder().previous_output(point).build(),
                f.tx.inputs().get(1).unwrap(),
            ])
            .build();
    assert!(verify(&f.c, &session_sign(tx, 1, 0)).is_err());
}
#[test]
fn passkey_owner_recovers_without_session_key_and_closes_authority() {
    let mut f = fixture();
    let proof = f.c.create_cell(
        CellOutput::new_builder()
            .capacity(500 * C)
            .lock(f.root.clone())
            .build(),
        Bytes::new(),
    );
    let tx = TransactionBuilder::default()
        .input(f.tx.inputs().get(0).unwrap())
        .input(CellInput::new_builder().previous_output(proof).build())
        .output(
            CellOutput::new_builder()
                .capacity(1500 * C - 500)
                .lock(f.root.clone())
                .build(),
        )
        .output_data(Bytes::new())
        .witness(
            WitnessArgs::new_builder()
                .lock(Some(Bytes::from(vec![0])).pack())
                .build()
                .as_bytes(),
        )
        .witness(WitnessArgs::default().as_bytes())
        .build();
    let tx = complete(&mut f.c, tx);
    verify(&f.c, &passkey_sign(tx, 1, None, ORIGIN, 5, false)).unwrap();
}
#[test]
fn session_cannot_make_user_pay_a_network_fee() {
    let f = fixture();
    let mut data = f.tx.outputs_data().get(0).unwrap().raw_data().to_vec();
    data[34..42].copy_from_slice(&(39 * C - 1).to_le_bytes());
    let tx =
        f.tx.as_advanced_builder()
            .set_outputs(vec![
                f.tx.outputs()
                    .get(0)
                    .unwrap()
                    .as_builder()
                    .capacity(939 * C - 1)
                    .build(),
                f.tx.outputs().get(1).unwrap(),
                f.tx.outputs().get(2).unwrap(),
            ])
            .set_outputs_data(vec![
                Bytes::from(data).pack(),
                Bytes::new().pack(),
                Bytes::new().pack(),
            ])
            .build();
    assert!(verify(&f.c, &session_sign(tx, 1, 0)).is_err());
}
#[test]
fn approved_arbitrary_data_policy_supports_app_state_outputs() {
    let mut f = fixture();
    let point = f.tx.inputs().get(0).unwrap().previous_output();
    let (cell, mut data) = f.c.get_cell(&point).unwrap();
    let mut raw = data.to_vec();
    raw[148..180].fill(0);
    data = Bytes::from(raw);
    f.c.create_cell_with_out_point(point, cell, data);
    let mut next = f.tx.outputs_data().get(0).unwrap().raw_data().to_vec();
    next[148..180].fill(0);
    let tx =
        f.tx.as_advanced_builder()
            .set_outputs_data(vec![
                Bytes::from(next).pack(),
                Bytes::from(vec![10, 20, 30, 40]).pack(),
                Bytes::new().pack(),
            ])
            .build();
    verify(&f.c, &session_sign(tx, 1, 0)).unwrap();
}
#[test]
fn session_rejects_lookalike_authority_that_is_not_builtin_typeid() {
    let mut f = fixture();
    let point = f.tx.inputs().get(0).unwrap().previous_output();
    let (cell, data) = f.c.get_cell(&point).unwrap();
    let fake = f.tx.outputs().get(1).unwrap().lock();
    let args = f.account.args().raw_data();
    let mut changed = args.to_vec();
    changed[32..64].copy_from_slice(fake.calc_script_hash().as_slice());
    let account = f
        .account
        .as_builder()
        .args(Bytes::from(changed).pack())
        .build();
    f.c.create_cell_with_out_point(
        point,
        cell.as_builder()
            .lock(account.clone())
            .type_(Some(fake.clone()).pack())
            .build(),
        data,
    );
    let tx =
        f.tx.as_advanced_builder()
            .set_outputs(vec![
                f.tx.outputs()
                    .get(0)
                    .unwrap()
                    .as_builder()
                    .lock(account)
                    .type_(Some(fake).pack())
                    .build(),
                f.tx.outputs().get(1).unwrap(),
                f.tx.outputs().get(2).unwrap(),
            ])
            .build();
    assert!(verify(&f.c, &session_sign(tx, 1, 0)).is_err());
}
#[test]
fn session_at_nonzero_input_and_extra_witnesses_remain_bound() {
    let mut f = fixture();
    let recipient = f.tx.outputs().get(1).unwrap().lock();
    let extra = f.c.create_cell(
        CellOutput::new_builder()
            .capacity(100 * C)
            .lock(recipient.clone())
            .build(),
        Bytes::new(),
    );
    let mut next = f.tx.outputs_data().get(0).unwrap().raw_data().to_vec();
    next[34..42].copy_from_slice(&(100 * C).to_le_bytes());
    let tx =
        f.tx.as_advanced_builder()
            .set_inputs(vec![
                CellInput::new_builder().previous_output(extra).build(),
                f.tx.inputs().get(0).unwrap(),
                f.tx.inputs().get(1).unwrap(),
            ])
            .set_outputs(vec![
                f.tx.outputs()
                    .get(0)
                    .unwrap()
                    .as_builder()
                    .capacity(1039 * C)
                    .build(),
                f.tx.outputs().get(1).unwrap(),
                f.tx.outputs().get(2).unwrap(),
            ])
            .set_outputs_data(vec![
                Bytes::from(next).pack(),
                Bytes::new().pack(),
                Bytes::new().pack(),
            ])
            .set_witnesses(vec![WitnessArgs::default().as_bytes().pack(); 3])
            .witness(Bytes::from(vec![1, 2]))
            .build();
    let signed = session_sign(tx, 1, 1);
    verify(&f.c, &signed).unwrap();
    let altered = signed
        .as_advanced_builder()
        .witness(Bytes::from(vec![3]))
        .build();
    assert!(verify(&f.c, &altered).is_err());
}

#[test]
fn embedded_passkey_accepts_signed_secure_top_origin() {
    let (c, tx) = root_fixture();
    for top in ["https://fon.example", "http://localhost:5177"] {
        verify(
            &c,
            &passkey_sign_context(tx.clone(), 0, Some(1), ORIGIN, 5, false, true, Some(top)),
        )
        .unwrap();
    }
}
#[test]
fn embedded_passkey_rejects_missing_insecure_or_contradictory_context() {
    let (c, tx) = root_fixture();
    for (cross, top) in [
        (true, None),
        (true, Some("null")),
        (true, Some("http://evil.example")),
        (true, Some("https://fon.example/path")),
        (true, Some("https://fon.example@evil.example")),
        (false, Some("https://fon.example")),
    ] {
        assert!(verify(
            &c,
            &passkey_sign_context(tx.clone(), 0, Some(1), ORIGIN, 5, false, cross, top)
        )
        .is_err());
    }
    let signed = passkey_sign_context(
        tx,
        0,
        Some(1),
        ORIGIN,
        5,
        false,
        true,
        Some("https://fon.example"),
    );
    let mut raw: Vec<Bytes> = signed
        .witnesses()
        .into_iter()
        .map(|w| w.raw_data())
        .collect();
    let args = WitnessArgs::from_slice(&raw[0]).unwrap();
    let lock = args.lock().to_opt().unwrap().raw_data();
    let mut changed = lock.to_vec();
    let start = changed.windows(3).position(|v| v == b"fon").unwrap();
    changed[start..start + 3].copy_from_slice(b"bad");
    raw[0] = args
        .as_builder()
        .lock(Some(Bytes::from(changed)).pack())
        .build()
        .as_bytes();
    assert!(verify(&c, &witnesses(signed, raw)).is_err());
}

#[test]
fn general_signature_can_authorize_dynamic_outputs_without_exact_policy_match() {
    let f = fixture_mode(true);
    let old = f.tx.outputs().get(1).unwrap();
    let changed = old
        .clone()
        .as_builder()
        .lock(
            old.lock()
                .as_builder()
                .args(Bytes::from(vec![99]).pack())
                .build(),
        )
        .build();
    let tx =
        f.tx.as_advanced_builder()
            .set_outputs(vec![
                f.tx.outputs().get(0).unwrap(),
                changed,
                f.tx.outputs().get(2).unwrap(),
            ])
            .build();
    // Deliberately proves the trust boundary: copied general keys can bypass software templates.
    verify(&f.c, &session_sign(tx, 1, 0)).unwrap();
}
#[test]
fn general_account_still_pins_state_budget_key_app_sequence_and_fee_sponsorship() {
    let f = fixture_mode(true);
    verify(&f.c, &session_sign(f.tx.clone(), 1, 0)).unwrap();
    assert!(verify(&f.c, &session_sign(f.tx.clone(), 2, 0)).is_err());
    for offset in [0, 1, 34, 42, 50, 83] {
        let mut data = f.tx.outputs_data().get(0).unwrap().raw_data().to_vec();
        data[offset] ^= 1;
        let tx =
            f.tx.as_advanced_builder()
                .set_outputs_data(vec![
                    Bytes::from(data).pack(),
                    Bytes::new().pack(),
                    Bytes::new().pack(),
                ])
                .build();
        assert!(verify(&f.c, &session_sign(tx, 1, 0)).is_err());
    }
    let pool =
        f.tx.outputs()
            .get(2)
            .unwrap()
            .as_builder()
            .capacity(1000 * C - 2000)
            .build();
    let tx =
        f.tx.as_advanced_builder()
            .set_outputs(vec![
                f.tx.outputs().get(0).unwrap(),
                f.tx.outputs().get(1).unwrap(),
                pool,
            ])
            .build();
    assert!(verify(&f.c, &session_sign(tx, 1, 0)).is_err());
}
#[test]
fn general_owner_recovers_without_a_session_key() {
    let mut f = fixture_mode(true);
    let proof = f.c.create_cell(
        CellOutput::new_builder()
            .capacity(500 * C)
            .lock(f.root.clone())
            .build(),
        Bytes::new(),
    );
    let tx = TransactionBuilder::default()
        .input(f.tx.inputs().get(0).unwrap())
        .input(CellInput::new_builder().previous_output(proof).build())
        .output(
            CellOutput::new_builder()
                .capacity(1500 * C - 500)
                .lock(f.root.clone())
                .build(),
        )
        .output_data(Bytes::new())
        .witness(
            WitnessArgs::new_builder()
                .lock(Some(Bytes::from(vec![0])).pack())
                .build()
                .as_bytes(),
        )
        .witness(WitnessArgs::default().as_bytes())
        .build();
    let tx = complete(&mut f.c, tx);
    verify(&f.c, &passkey_sign(tx, 1, None, ORIGIN, 5, false)).unwrap();
}
